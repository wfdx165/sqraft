/**
 * 数据目录：平台惯例的 `userData`（macOS `~/Library/Application Support/Sqraft`、
 * Windows `%APPDATA%\Sqraft`、Linux `~/.config/Sqraft`）。
 *
 * 2026-11 修订（见 `.scratch/ai-native-revamp/issues/03-data-dir-migration.md`）：
 * 原先 `app.setPath("userData", ~/.sqraft)` 把**整个 userData（含 Chromium profile）**
 * 拐进家目录点目录，初衷是"用户找得到、好备份"（`.scratch/ai-native-polish/issues/15-data-directory.md`）。
 * 副作用有三个：浏览器缓存 158MB 躺在用户家目录；`cache/images` 与 Chromium 的 `Cache/`
 * 在大小写不敏感的卷上**撞成同一目录**（清缓存会连带清掉链接图缓存）；而且偏离平台惯例——
 * `~/Library` 是隐藏目录，普通用户更看不见。
 *
 * 现在按惯例回迁：应用自有数据（`preferences.json` / `mcp.json` / `image-cache/`）留在
 * `userData` 顶层，Chromium 的**状态文件**（Local Storage、Session Storage、Cookies 等）归位，
 * 可再生的浏览器缓存（`Cache`、`Code Cache`、`GPUCache`…）按拍板 **M2 原地不动**。
 * 日志单独走平台日志目录（`app.getPath("logs")`，macOS `~/Library/Logs/Sqraft/`）——
 * 诊断产物不跟用户数据混放，Console.app 也能直接列出来。
 * 迁移一次性、同步执行（必须在任何 Chromium 存储被打开之前完成）、失败不阻断启动。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** userData 目录名（与 electron-builder 的 `productName` 保持一致） */
export const USER_DATA_NAME = "Sqraft";
/** 离开的旧目录名（家目录点目录） */
export const LEGACY_DOT_DIRNAME = ".sqraft";
/** 迁移标记（写在目标目录）：存在即已迁移，绝不重复跑 */
export const MIGRATION_MARKER = "migration-from-dot-dir";
/**
 * 链接图缓存的目录名（相对 userData）。
 * **不能叫 `cache`**：Chromium 的 HTTP 缓存在 `userData/Cache`，大小写不敏感的卷上
 * 两者会变成同一个目录——清浏览器缓存会连带删掉链接图字节。
 */
export const IMAGE_CACHE_DIRNAME = "image-cache";
/** 被"源覆盖目标"换下来的陈旧条目：先改名归档，成功后再清，避免重试时误删新写入 */
const BACKUP_SUFFIX = ".pre-migration";

/** 旧目录里属于应用自己的内容（优先搬；`preferences.json` 覆盖目标侧的陈旧副本） */
const APP_DATA_ENTRIES = new Set(["preferences.json", "mcp.json"]);
/** 可再生的浏览器缓存：不搬，按 M2 留在旧目录当残留（搬过去只是 158MB 无用数据） */
const CHROMIUM_CACHE_ENTRIES = new Set([
  "cache",
  "code cache",
  "gpucache",
  "gpushersistentcache",
  "dawngraphitecache",
  "dawnwebgpucache",
  "graphitedawncache",
  "shared dictionary",
]);

/**
 * 其余 Chromium 条目都按**状态文件**搬走（Local Storage、Session Storage、Cookies、
 * Preferences、IndexedDB、blob_storage…）——自定义快捷键与标尺/网格/吸附开关就在
 * `Local Storage` 里，丢了等于用户改过的东西清零。规则刻意保守：**不认识的一律搬**，
 * 搬错方向只会在旧目录多留残留，不会丢数据。
 */

/** 旧目录里不搬的残留（M2 原地不动）：迁移标记、socket、系统垃圾、写偏好的临时文件 */
function isResidue(name: string): boolean {
  return (
    name === MIGRATION_MARKER ||
    name === ".migrated-from-userdata" ||
    name === "mcp.sock" ||
    name === ".DS_Store" ||
    name === "SingletonCookie" ||
    name === "SingletonLock" ||
    name === "SingletonSocket" ||
    name === "DevToolsActivePort" ||
    (name.startsWith(".preferences.json.") && name.endsWith(".tmp"))
  );
}

/** userData 绝对路径：由 Electron 的 `appData`（各平台惯例根）推导 */
export function userDataDirOf(appData: string): string {
  return join(appData, USER_DATA_NAME);
}

/** 旧的家目录点目录（迁移源） */
export function legacyDotDirOf(home: string): string {
  return join(home, LEGACY_DOT_DIRNAME);
}

/**
 * 整体搬一个条目到目标（同卷 rename，几万条目也是常数时间）。
 * 目标已有同名条目时**先改名归档再搬**——语义仍是"源覆盖陈旧目标"，
 * 但被换下来的那份留在 `<名字>.pre-migration`，成功后才清掉：
 * 迁移失败后继续使用产生的新状态（新日志、改过的 Local Storage）不会被静默删除。
 */
function moveEntry(from: string, to: string): boolean {
  if (!existsSync(from)) return false; // 已经搬过（重试场景）
  mkdirSync(dirname(to), { recursive: true });
  moveAside(to);
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
  return true;
}

/** 把目标侧同名条目改名归档（上一次的归档先删，避免无限堆积） */
function moveAside(to: string): void {
  if (!existsSync(to)) return;
  const backup = `${to}${BACKUP_SUFFIX}`;
  rmSync(backup, { recursive: true, force: true });
  renameSync(to, backup);
}

/** 迁移成功后清掉本轮归档；崩溃留下的残留在下次启动被覆盖，不会累积 */
function sweepBackups(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(BACKUP_SUFFIX)) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

export interface MigrateResult {
  status: "no-source" | "already" | "migrated" | "failed";
  /** 本次真正搬过去的顶层条目（日志用，不含"源里没有"的跳过项） */
  moved: string[];
  /** status === "failed" 时的原因；不写标记，下次启动重试 */
  error?: string;
}

/**
 * 把旧家目录点目录迁到平台惯例的 `userData`。幂等：缺源跳过、已迁标记返回。
 * 调用方必须在 `app.setPath("userData", target)` 之后、initLogFile 与任何
 * Chromium 存储访问之前同步调用——Local Storage 的搬运必须早于渲染层起来。
 */
export function migrateFromLegacyDotDir(options: { legacy: string; target: string; logs: string }): MigrateResult {
  const { legacy, target, logs } = options;
  const marker = join(target, MIGRATION_MARKER);
  const moved: string[] = [];
  try {
    if (!existsSync(legacy)) return { status: "no-source", moved };
    if (existsSync(marker)) return { status: "already", moved };

    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(legacy)) {
      const lower = name.toLowerCase();

      // 0) 日志走平台日志目录（`app.getPath("logs")`），不跟用户数据同目录
      if (lower === "logs") {
        if (moveEntry(join(legacy, name), logs)) moved.push("logs");
        continue;
      }

      // 1) 链接图缓存住在 Chromium 的 `Cache/` 里（大小写不敏感卷上是同一目录）：
      //    必须先单独抽出来，否则它会跟着可再生缓存一起被留下
      if (lower === "cache") {
        const cacheDir = join(legacy, name);
        if (!readdirLike(cacheDir)) continue;
        for (const inner of readdirSync(cacheDir)) {
          if (inner.toLowerCase() !== "images") continue;
          if (moveEntry(join(cacheDir, inner), join(target, IMAGE_CACHE_DIRNAME))) moved.push(IMAGE_CACHE_DIRNAME);
        }
        continue; // Chromium 的 HTTP 缓存本体按 M2 留下
      }

      if (isResidue(name)) continue; // M2：残留原地不动
      if (APP_DATA_ENTRIES.has(name)) {
        if (moveEntry(join(legacy, name), join(target, name))) moved.push(name);
        continue;
      }
      // 2) Chromium 状态文件与任何不认识的条目：搬（规则见 CHROMIUM_CACHE_ENTRIES 上方）
      if (CHROMIUM_CACHE_ENTRIES.has(lower)) continue; // 可再生缓存：M2 留下
      if (moveEntry(join(legacy, name), join(target, name))) moved.push(name);
    }

    sweepBackups(target);
    sweepBackups(logs);
    writeFileSync(marker, new Date().toISOString(), "utf8");
    return { status: "migrated", moved };
  } catch (error) {
    return { status: "failed", moved, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 目录存在且可读（避免对文件调 readdirSync） */
function readdirLike(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把"曾经放在 userData/cache/images 里的链接图缓存"挪到 `userData/image-cache/`。
 *
 * 为什么需要独立于迁移标记：初版实现（2026-11 早期构建）已经把这批图片搬进了
 * `userData/Cache/images`——在大小写不敏感卷上那正是 Chromium 的 HTTP 缓存目录。
 * 主迁移标记已写，主流程不再跑，所以这里每次启动都检查一次；没有旧目录就是零成本 no-op。
 *
 * 只动 `images` 子目录，Chromium 的 `Cache_Data` 等一律不碰；逐文件搬，崩溃可续。
 */
export function relocateImageCache(userData: string): { from: string; to: string } | null {
  const from = join(userData, "cache", "images");
  const to = join(userData, IMAGE_CACHE_DIRNAME);
  if (!readdirLike(from)) return null;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) moveEntry(join(from, name), join(to, name));
  try {
    rmdirSync(from); // 只在空目录时成功；里面还有东西就留着，下次继续
  } catch {
    /* 非空或已不存在：留给下次启动 */
  }
  return { from, to };
}
