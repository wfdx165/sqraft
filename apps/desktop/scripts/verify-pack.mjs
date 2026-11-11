/**
 * 成品防护验收（ADR-0030）。挂在发版链路里，跑在构建之后、上传之前。
 *
 * 为什么需要它：这类泄露最容易复发——有人把依赖挪回 `dependencies`、改回 `files`、
 * 或者关掉压缩，包里就又多出源码和 map，而且没人会发现。这里把"成品长什么样"
 * 写成断言：不合格就中止发版，别把包传上去。
 *
 * 检查项：
 * 1. `dependencies` 为空（运行时不需要任何 node_modules，见 ADR-0030）；
 * 2. asar 里只有 `out/**` 与 `package.json`，不含 `.ts/.tsx/.vue/.map/.md`、不含 `node_modules`；
 * 3. 渲染层 bundle 是压缩过的（行数很少）；
 * 4. Electron fuse 已按要求翻转。
 *
 * 用法：`node scripts/verify-pack.mjs [产物路径]`。
 * 默认按平台挑：Windows 用 `release/win-unpacked`，其余用 `release/mac-arm64/Sqraft.app`。
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAC_APP = join(packageRoot, "release", "mac-arm64", "Sqraft.app");
const WIN_DIR = join(packageRoot, "release", "win-unpacked");

/** 默认产物：显式参数优先；否则看 release/ 里实际有什么。 */
function defaultTarget() {
  if (process.argv[2]) return process.argv[2];
  if (existsSync(WIN_DIR) && process.platform === "win32") return WIN_DIR;
  if (existsSync(MAC_APP)) return MAC_APP;
  if (existsSync(WIN_DIR)) return WIN_DIR;
  return MAC_APP;
}

const appPath = resolve(defaultTarget());
/** `.app` 包与 `win-unpacked` 目录的内部布局不同，后面按这个分支取 asar 与主程序。 */
const isMacBundle = appPath.endsWith(".app");
const product = isMacBundle ? appPath.replace(/\.app$/, "").split("/").pop() : "Sqraft";
const problems = [];

/* ---------- 1. 依赖分类 ---------- */

const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
if (runtimeDeps.length > 0) {
  problems.push(
    `dependencies 应为空，实际有 ${runtimeDeps.length} 个（${runtimeDeps.join("、")}）——` +
      "它们会被整棵复制进 asar；只在构建期用的依赖请放 devDependencies",
  );
}

/* ---------- 2. asar 内容 ---------- */

/** 读 asar 头。格式：[uint32 4][uint32 头总长][uint32 载荷长][uint32 JSON 长][JSON]。 */
function readAsar(path) {
  const fd = openSync(path, "r");
  try {
    const sizeBuf = Buffer.alloc(8);
    readSync(fd, sizeBuf, 0, 8, 0);
    const headerTotal = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerTotal);
    readSync(fd, headerBuf, 0, headerTotal, 8);
    const jsonSize = headerBuf.readUInt32LE(4);
    const header = JSON.parse(headerBuf.subarray(8, 8 + jsonSize).toString("utf8"));

    const entries = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const path = `${prefix}/${name}`;
        if (child.files) walk(child, path);
        // asar 头里的 size/offset 是大整数字符串（可能超过 2^53），这里用 Number 足够
        else entries.push({ path, size: Number(child.size ?? 0), offset: Number(child.offset ?? 0) });
      }
    };
    walk(header, "");

    // 文件数据的起点：8 字节头长度 + 头本身；条目 offset 相对它
    const dataStart = 8 + headerTotal;
    const read = (entry) => {
      const dataFd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(entry.size);
        readSync(dataFd, buffer, 0, entry.size, dataStart + entry.offset);
        return buffer;
      } finally {
        closeSync(dataFd);
      }
    };
    return { entries, read };
  } finally {
    closeSync(fd);
  }
}

const asarPath = isMacBundle
  ? join(appPath, "Contents", "Resources", "app.asar")
  : join(appPath, "resources", "app.asar");
let asar;
try {
  statSync(asarPath);
  asar = readAsar(asarPath);
} catch (error) {
  console.error(`verify-pack: 读不了 ${asarPath}（${String(error)}）——先构建，或用参数指定产物路径`);
  process.exit(1);
}

const FORBIDDEN = /\.(ts|tsx|vue|map|md|mjs)$/;
const unexpected = [];
for (const entry of asar.entries) {
  if (entry.path.includes("/node_modules/")) unexpected.push(`${entry.path}（node_modules）`);
  else if (FORBIDDEN.test(entry.path)) unexpected.push(`${entry.path}（源码或 map）`);
  else if (entry.path !== "/package.json" && !entry.path.startsWith("/out/")) {
    unexpected.push(`${entry.path}（不在 out/ 或 package.json 里）`);
  }
}
if (unexpected.length > 0) {
  problems.push(
    `asar 里出现了不该进包的文件（${unexpected.length} 个，示例 ${unexpected.slice(0, 5).join("；")}）`,
  );
}

/* ---------- 3. 渲染层是否压缩 ---------- */

const bundles = asar.entries.filter((entry) => entry.path.startsWith("/out/renderer/") && entry.path.endsWith(".js"));
if (bundles.length === 0) {
  problems.push("asar 里找不到渲染层 bundle（/out/renderer/**/*.js）");
} else {
  const largest = bundles.reduce((a, b) => (a.size >= b.size ? a : b));
  const lines = asar.read(largest).toString("utf8").split("\n").length;
  if (lines > 50) {
    problems.push(`${largest.path} 有 ${lines} 行，看起来没有压缩（预期 esbuild 产出个位数行）`);
  }
}

/* ---------- 4. fuse ---------- */

/** Windows 主程序：优先 `Sqraft.exe`；只有一个 exe 时接受它，多个就明确报错而不是猜。 */
function windowsBinaryOf(dir) {
  const preferred = join(dir, "Sqraft.exe");
  if (existsSync(preferred)) return preferred;
  const candidates = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".exe"));
  if (candidates.length === 1) return join(dir, candidates[0]);
  problems.push(
    `找不到主程序：${preferred} 不存在，目录里的 .exe 有 ${candidates.length} 个（${candidates.join("、") || "无"}）`,
  );
  return preferred;
}

const binary = isMacBundle
  ? join(appPath, "Contents", "MacOS", product)
  : windowsBinaryOf(appPath);
const EXPECTED = [
  [FuseV1Options.RunAsNode, FuseState.DISABLE, "以 Node 运行主进程"],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE, "从 NODE_OPTIONS 注入"],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE, "附带调试参数启动"],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE, "只能从 asar 加载"],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.DISABLE, "asar 完整性校验（未签名时无效）"],
];

try {
  const wire = await getCurrentFuseWire(binary);
  for (const [option, expected, label] of EXPECTED) {
    const actual = wire[option] ?? wire[String(option)];
    if (actual !== expected) {
      problems.push(`fuse「${label}」状态不对：期望 ${FuseState[expected]}，实际 ${FuseState[actual] ?? actual}`);
    }
  }
} catch (error) {
  problems.push(`读不了 fuse 状态（${String(error)}），确认 ${binary} 存在`);
}

/* ---------- 结论 ---------- */

if (problems.length > 0) {
  console.error("verify-pack: 成品不合格（ADR-0030）");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `verify-pack: 通过（${isMacBundle ? "macOS .app" : "Windows win-unpacked"}）——asar ${asar.entries.length} 个条目，` +
    `全部在 out/ 与 package.json 内；无源码 / 无 map / 无 node_modules；渲染层已压缩；fuse 已按要求翻转`,
);
