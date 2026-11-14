/**
 * 安装：应用退出后由一个 detached 的 `/bin/sh` 脚本替换 `Sqraft.app`。
 *
 * 为什么不用 `electron-updater` / Squirrel.Mac：macOS 上它会校验代码签名，
 * 立项时本项目未签名（ADR-0029），启动时就报 "Could not get code signature"。
 * 2026-11 起 macOS 包已用 Developer ID 签名（公证暂缓，ADR-0034），但这条链路已验过替换与回滚，
 * 迁移仍是独立一票。
 *
 * 脚本做四件事：等进程退出 → 备份旧包 → 解包并落位 → 启动后等启动标记，
 * 超时自动回滚。只有"新版本真的跑起来了"才算安装成功。
 */
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, rmSync, writeFileSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { t } from "../i18n";

export interface InstallPaths {
  appPath: string;
  backupPath: string;
  zipPath: string;
  scriptPath: string;
  logPath: string;
  markerPath: string;
  failedPath: string;
  stagingPath: string;
}

/** 从可执行文件路径反推 `.app` 包：`…/Sqraft.app/Contents/MacOS/Sqraft`。 */
export function appBundlePathOf(executable: string): string | null {
  const marker = "/Contents/MacOS/";
  const at = executable.indexOf(marker);
  if (at <= 0) return null;
  const appPath = executable.slice(0, at);
  return appPath.endsWith(".app") ? appPath : null;
}

export interface InstallSupport {
  /**
   * install：能下载并替换应用包（macOS arm64）。
   * notify：只能提示新版本并打开下载页（Windows，本版不做静默安装）。
   * none：连检查都不做（开发态 / 其他平台）。
   */
  mode: "install" | "notify" | "none";
  /** 不支持的面向用户原因（可检查时为空串） */
  reason: string;
  appPath: string | null;
}

export interface SupportOptions {
  packaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  executable: string;
  /** 测试注入；生产用 fs.access */
  isWritable?: (dir: string) => Promise<boolean>;
}

async function defaultIsWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 能否就地替换。不可写位置（dmg 挂载点、AppTranslocation、只读目录）一律提前拒绝，
 * 免得下载了 120MB 才失败。
 */
export async function resolveInstallSupport(options: SupportOptions): Promise<InstallSupport> {
  const writable = options.isWritable ?? defaultIsWritable;
  if (!options.packaged) return { mode: "none", reason: t("update.dev"), appPath: null };
  // Windows 没有自替换逻辑：只检查版本并引导用户去下载页（安装器不支持静默升级）
  if (options.platform === "win32") return { mode: "notify", reason: "", appPath: null };
  if (options.platform !== "darwin") {
    return { mode: "none", reason: t("update.reasonPlatform"), appPath: null };
  }
  if (options.arch !== "arm64") {
    return { mode: "none", reason: t("update.reasonArch"), appPath: null };
  }
  const appPath = appBundlePathOf(options.executable);
  if (!appPath) return { mode: "none", reason: t("update.reasonNoApp"), appPath: null };
  if (appPath.startsWith("/Volumes/") || appPath.includes("/AppTranslocation/")) {
    return { mode: "none", reason: t("update.reasonReadOnly"), appPath };
  }
  if (!(await writable(dirname(appPath)))) {
    return { mode: "none", reason: t("update.reasonNoPermission"), appPath };
  }
  return { mode: "install", reason: "", appPath };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function installPathsOf(appPath: string, userData: string): InstallPaths {
  const updates = join(userData, "updates");
  return {
    appPath,
    backupPath: `${appPath}.backup`,
    zipPath: join(updates, "update.zip"),
    scriptPath: join(updates, "install.sh"),
    logPath: join(updates, "install.log"),
    markerPath: join(updates, "launched"),
    failedPath: join(updates, "install-failed.json"),
    stagingPath: join(updates, "staging"),
  };
}

export interface ScriptOptions extends InstallPaths {
  /** 主进程 pid：脚本等它消失后才动应用包 */
  pid: number;
  version: string;
  /** `.app` 的目录名，解包后就在 staging 下 */
  appName: string;
  /**
   * 当前正在运行的 App 的签名 Team（ADR-0034）。替换前用它在脚本里校验新包：
   * 签名无效或 Team 不同就保留旧版本。旧版本（未签名）启动时这里是空串，脚本跳过校验。
   */
  expectedTeam?: string;
  /** 启动看门狗轮询次数（每次 0.5s） */
  waitTicks?: number;
}

/**
 * 读当前 App 的签名 Team ID；读不到（未签名 / 非 mac）返回空串。
 *
 * 不写死 Team：期望值来自"当前正在运行的包"，新版本必须与它同源——换证书续期后
 * 老客户端自然会要求一次同 Team 的签名，不需要跟着改代码。
 */
export function signingTeamOf(appPath: string): string {
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? "";
}

/**
 * 生成安装脚本。所有路径都以单引号字面量内联（应用名固定 Sqraft，
 * 用户数据目录可能含空格，不能靠 env 拼接）。
 */
export function buildInstallScript(options: ScriptOptions): string {
  const waitTicks = options.waitTicks ?? 120;
  return `#!/bin/sh
# 由 Sqraft 生成：等进程退出后替换应用包；新版本启动后等启动标记，超时自动回滚。
set -u
APP=${shellQuote(options.appPath)}
BACKUP=${shellQuote(options.backupPath)}
ZIP=${shellQuote(options.zipPath)}
STAGING=${shellQuote(options.stagingPath)}
MARK=${shellQuote(options.markerPath)}
FAILED=${shellQuote(options.failedPath)}
LOG=${shellQuote(options.logPath)}
APPNAME=${shellQuote(options.appName)}
VERSION=${shellQuote(options.version)}
EXPECTED_TEAM=${shellQuote(options.expectedTeam ?? "")}
PID=${options.pid}
WAIT_TICKS=${waitTicks}

log() { printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$LOG"; }

log "等待主进程退出 (pid=$PID)"
i=0
while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.2; i=$((i+1)); done
if kill -0 "$PID" 2>/dev/null; then
  log "进程仍未退出，放弃本次安装（旧版本保持可用）"
  exit 1
fi

rm -rf "$STAGING"
mkdir -p "$STAGING"
if ! ditto -x -k "$ZIP" "$STAGING" >> "$LOG" 2>&1; then
  log "解包失败，保留旧版本"
  rm -rf "$STAGING"
  exit 1
fi

if [ ! -d "$STAGING/$APPNAME" ]; then
  log "解包后找不到 $APPNAME，保留旧版本"
  rm -rf "$STAGING"
  exit 1
fi

# 替换前校验新包身份（ADR-0034）：签名无效或 Team 不同就保留旧版本。
# 旧版本未签名时 EXPECTED_TEAM 为空，跳过这段（0.0.4 → 签名首发的过渡）。
if [ -n "$EXPECTED_TEAM" ]; then
  if ! /usr/bin/codesign --verify --deep --strict "$STAGING/$APPNAME" >> "$LOG" 2>&1; then
    log "新包签名校验失败，保留旧版本（包不完整或被篡改）"
    rm -rf "$STAGING"
    rm -f "$ZIP"
    printf '%s\\n' "$VERSION" > "$FAILED"
    exit 1
  fi
  NEW_TEAM=$(/usr/bin/codesign -dv --verbose=4 "$STAGING/$APPNAME" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -1)
  if [ "$NEW_TEAM" != "$EXPECTED_TEAM" ]; then
    log "新包 Team 为 $NEW_TEAM，与当前 $EXPECTED_TEAM 不一致，保留旧版本"
    rm -rf "$STAGING"
    rm -f "$ZIP"
    printf '%s\\n' "$VERSION" > "$FAILED"
    exit 1
  fi
fi

rm -rf "$BACKUP"
if ! mv "$APP" "$BACKUP"; then
  log "无法移走旧版本（目录只读？），保留旧版本"
  rm -rf "$STAGING"
  exit 1
fi

if ! mv "$STAGING/$APPNAME" "$APP"; then
  log "新版本落位失败，回滚旧版本"
  mv "$BACKUP" "$APP"
  rm -rf "$STAGING"
  exit 1
fi

rm -rf "$STAGING"
rm -f "$MARK"
log "已安装 $VERSION，启动新版本"
open "$APP" >> "$LOG" 2>&1

i=0
while [ ! -f "$MARK" ] && [ "$i" -lt "$WAIT_TICKS" ]; do sleep 0.5; i=$((i+1)); done

if [ -f "$MARK" ]; then
  log "新版本启动成功，清理备份"
  rm -rf "$BACKUP"
  rm -f "$ZIP"
  exit 0
fi

log "新版本启动超时，回滚到旧版本"
pkill -f "$APP/Contents/MacOS/" >> "$LOG" 2>&1 || true
sleep 1
rm -rf "$APP"
mv "$BACKUP" "$APP"
# 坏包必须删掉：应用侧看到 update.zip 还在会把同一个版本重新认领成"已就绪"
rm -f "$ZIP"
rm -rf "$STAGING"
printf '%s\\n' "$VERSION" > "$FAILED"
open "$APP" >> "$LOG" 2>&1
exit 1
`;
}

/** 写脚本并 detached 启动；调用方负责确认"已就绪且可写"。 */
export async function spawnInstaller(options: ScriptOptions): Promise<void> {
  const script = buildInstallScript(options);
  await mkdir(dirname(options.scriptPath), { recursive: true });
  await writeFile(options.scriptPath, script, "utf8");
  await chmod(options.scriptPath, 0o755);
  await rm(options.failedPath, { force: true });
  const child = spawn("/bin/sh", [options.scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * `will-quit` 里的同步版本：进程马上要退出，等不了异步写盘。
 * 脚本必须在这一刻完整落盘并启动，否则本次安装会静默丢失。
 */
export function spawnInstallerSync(options: ScriptOptions): void {
  const script = buildInstallScript(options);
  mkdirSync(dirname(options.scriptPath), { recursive: true });
  writeFileSync(options.scriptPath, script, "utf8");
  chmodSync(options.scriptPath, 0o755);
  rmSync(options.failedPath, { force: true });
  const child = spawn("/bin/sh", [options.scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
