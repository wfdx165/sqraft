/**
 * 更新器：半静默（ADR-0029）。
 *
 * - 启动后延迟 5 秒检查一次，24 小时节流；失败静默，只写日志。
 * - 有新版本就后台下载 zip、校验 sha256，进入"已就绪"。
 * - 退出时由 detached 脚本替换 `Sqraft.app`；就绪满 7 天主动提醒一次，永不强制重启。
 * - 不做 beta 通道、不做"跳过此版本"、不签名。
 *
 * 状态判定（该不该查、查到后做什么、启动时恢复成什么）都在 `decisions.ts` /
 * `reconcile.ts` 里，本文件只做 Electron / 网络 / 文件系统胶水。
 */
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { basename, join } from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { CHANNELS, type UpdateState } from "../../shared/ipc";
import { logApp } from "../mcp/log";
import { patchUpdatePreferences, updatePreferences } from "../recent-state";
import { planForLatest, shouldCheck } from "./decisions";
import { downloadVerified } from "./download";
import { installPathsOf, resolveInstallSupport, spawnInstallerSync, type InstallSupport } from "./install";
import { t } from "../i18n";
import { reconcileOnStart } from "./reconcile";
import { isTrustedUpdateUrl, parseLatest, UpdateManifestError } from "./protocol";
// 发布仓库的唯一真源：`scripts/release.mjs` 读同一份配置，避免脚本和客户端指向不同仓库
import updateConfig from "../../../update.config.json";
import type { UpdateAsset } from "./protocol";

export const UPDATE_REPO = updateConfig.repo;

const LATEST_URL = `https://github.com/${UPDATE_REPO}/releases/latest/download/latest.json`;
/** 启动后延迟检查：不和窗口首帧、MCP 启动抢资源 */
const CHECK_DELAY_MS = 5_000;
/** 就绪多久后主动提醒一次 */
const REMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

let state: UpdateState = {
  phase: "idle",
  currentVersion: "0.0.0",
  latestVersion: null,
  notes: null,
  publishedAt: null,
  progress: 0,
  message: null,
  readyAt: null,
  supported: false,
};

let support: InstallSupport = { ok: false, reason: "", appPath: null };
let checkInFlight: Promise<UpdateState> | null = null;
let initialized = false;

function publish(patch: Partial<UpdateState>): UpdateState {
  state = { ...state, ...patch };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.updateChanged, state);
  }
  return state;
}

function updatesDir(): string {
  return join(app.getPath("userData"), "updates");
}

function paths() {
  if (!support.appPath) throw new Error(t("update.locateAppFailed"));
  return installPathsOf(support.appPath, app.getPath("userData"));
}

/** 启动标记：安装脚本用它判断新版本有没有真正跑起来。越早写越好。 */
async function writeLaunchMarker(): Promise<void> {
  try {
    await mkdir(updatesDir(), { recursive: true });
    await writeFile(paths().markerPath, app.getVersion(), "utf8");
  } catch (error) {
    logApp("warn", "update: launch marker failed", { error: messageOf(error) });
  }
}

/** 上次安装失败的回执（脚本回滚时写下的版本号）。 */
async function readFailedVersion(): Promise<string | null> {
  try {
    const text = (await readFile(paths().failedPath, "utf8")).trim();
    return text || null;
  } catch {
    return null;
  }
}

async function zipPresent(): Promise<boolean> {
  try {
    await stat(paths().zipPath);
    return true;
  } catch {
    return false;
  }
}

async function fetchLatest(): Promise<unknown> {
  const response = await fetch(LATEST_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(t("update.checkHttp", { status: response.status }));
  // 自动跟随之后再看终点：只有 GitHub 自家域名可以承载元数据
  if (!isTrustedUpdateUrl(response.url)) throw new Error(t("update.untrustedMeta"));
  return response.json();
}

async function downloadUpdate(version: string, asset: UpdateAsset): Promise<void> {
  const dest = paths().zipPath;
  let lastPercent = -1;
  publish({ phase: "downloading", progress: 0 });
  await downloadVerified({
    url: asset.url,
    dest,
    sha256: asset.sha256,
    size: asset.size,
    onProgress: (received, total) => {
      if (!total) return;
      const progress = Math.min(1, received / total);
      const percent = Math.floor(progress * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      publish({ progress });
    },
  });
  const readyAt = Date.now();
  // 下载成功即视为"这个版本可用"：清掉历史上同一版本的失败记录
  await patchUpdatePreferences({ readyVersion: version, readySince: readyAt, failedVersion: undefined });
  publish({ phase: "ready", progress: 1, readyAt });
}

async function runCheck(manual: boolean): Promise<UpdateState> {
  const started = Date.now();
  publish({ phase: "checking", message: null, progress: 0 });
  try {
    const manifest = parseLatest(await fetchLatest());
    await patchUpdatePreferences({ lastCheckAt: Date.now() }).catch(() => undefined);
    const plan = planForLatest({
      currentVersion: app.getVersion(),
      manifest,
      failedVersion: updatePreferences().failedVersion ?? null,
      manual,
    });

    if (plan.kind === "up-to-date") {
      logApp("info", "update: up to date", {
        version: app.getVersion(),
        latest: plan.version,
        ms: Date.now() - started,
      });
      return publish({
        phase: "up-to-date",
        latestVersion: plan.version,
        notes: plan.notes,
        publishedAt: plan.publishedAt,
      });
    }

    if (plan.kind === "skipped-failed") {
      logApp("warn", "update: skipped previously failed version", { version: plan.version });
      return publish({ phase: "idle", message: null });
    }

    logApp("info", "update: new version", {
      current: app.getVersion(),
      latest: plan.version,
      manual,
    });
    publish({ latestVersion: plan.version, notes: plan.notes, publishedAt: plan.publishedAt });
    await downloadUpdate(plan.version, plan.asset);
    logApp("info", "update: ready", { version: plan.version, ms: Date.now() - started });
    return state;
  } catch (error) {
    const message = messageOf(error);
    logApp(manual ? "warn" : "info", "update: check failed", { manual, error: message, ms: Date.now() - started });
    // 自动检查失败对用户不可见；手动检查必须给出原因
    if (manual) return publish({ phase: "error", message });
    return publish({ phase: "idle", message: null });
  }
}

/** 检查更新。`manual` 忽略 24 小时节流，并把失败原因留在状态里。 */
export async function checkForUpdates(manual = false): Promise<UpdateState> {
  if (!support.ok) return state;
  if (checkInFlight) return checkInFlight;
  if (!shouldCheck({ prefs: updatePreferences(), manual, phase: state.phase, now: Date.now() })) return state;
  checkInFlight = runCheck(manual).finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

/** 重启以安装：走关闭守卫，未保存改动会先问（与 ⌘Q 同一条路径）。 */
export function restartToInstall(): void {
  if (state.phase !== "ready") return;
  logApp("info", "update: restart requested", { version: state.latestVersion });
  app.quit();
}

/** 就绪满 7 天后主动提醒一次（同一版本只提醒一次），不强制重启。 */
function scheduleReminder(): void {
  const prefs = updatePreferences();
  if (state.phase !== "ready" || !state.latestVersion || !prefs.readySince) return;
  if (Date.now() - prefs.readySince < REMIND_AFTER_MS) return;
  if (prefs.remindedVersion === state.latestVersion) return;
  setTimeout(() => {
    if (state.phase !== "ready" || !state.latestVersion) return;
    const version = state.latestVersion;
    void patchUpdatePreferences({ remindedVersion: version }).catch(() => undefined);
    logApp("info", "update: reminder shown", { version });
    void dialog
      .showMessageBox({
        type: "info",
        buttons: [t("update.restartNow"), t("update.later")],
        defaultId: 0,
        cancelId: 1,
        message: t("update.readyTitle", { version }),
        detail: t("update.readyDetail"),
      })
      .then((result) => {
        if (result.response === 0) restartToInstall();
      });
  }, 3_000);
}

/** 回滚回执：只提示一次，状态已经在 reconcile 里清干净了。 */
function showRollbackNotice(message: string): void {
  setTimeout(() => {
    void dialog.showMessageBox({
      type: "warning",
      buttons: [t("common.ok")],
      message,
      detail: t("update.rollbackDetail", { version: app.getVersion(), path: join(updatesDir(), "install.log") }),
    });
  }, 1_500);
}

/** 退出时安装。必须同步落盘：`will-quit` 之后进程就没了。 */
export function installOnQuit(): void {
  app.on("will-quit", () => {
    if (state.phase !== "ready" || !support.ok || !state.latestVersion) return;
    try {
      spawnInstallerSync({
        ...paths(),
        pid: process.pid,
        version: state.latestVersion,
        appName: basename(support.appPath ?? "Sqraft.app"),
      });
      logApp("info", "update: installer spawned", { version: state.latestVersion });
    } catch (error) {
      logApp("error", "update: installer spawn failed", { error: messageOf(error) });
    }
  });
}

export async function initUpdater(): Promise<void> {
  if (initialized) return;
  initialized = true;
  support = await resolveInstallSupport({
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    executable: process.execPath,
  });
  const currentVersion = app.getVersion();
  if (!support.ok) {
    state = {
      ...state,
      currentVersion,
      supported: false,
      phase: app.isPackaged ? "unsupported" : "dev",
      message: support.reason,
    };
    logApp("info", "update: initialized", {
      supported: false,
      reason: support.reason,
      version: currentVersion,
    });
    return;
  }

  state = { ...state, currentVersion, supported: true };
  await writeLaunchMarker();

  // 先看有没有"上次装坏了"的回执，再决定是否接管已下载包（顺序不能反，见 reconcile.ts）
  const reconciled = reconcileOnStart({
    currentVersion,
    prefs: updatePreferences(),
    failedVersion: await readFailedVersion(),
    zipPresent: await zipPresent(),
    now: Date.now(),
  });
  state = reconciled.state;
  if (reconciled.message) {
    state = { ...state, message: t(reconciled.message.key, reconciled.message.params) };
  }
  if (Object.keys(reconciled.patch).length > 0) {
    await patchUpdatePreferences(reconciled.patch).catch((error: unknown) => {
      logApp("warn", "update: reconcile persist failed", { error: messageOf(error) });
    });
  }
  if (reconciled.removeZip) await rm(paths().zipPath, { force: true }).catch(() => undefined);
  if (reconciled.clearFailure) await rm(paths().failedPath, { force: true }).catch(() => undefined);
  if (reconciled.prompt) {
    showRollbackNotice(t(reconciled.prompt.key, reconciled.prompt.params));
  }

  logApp("info", "update: initialized", {
    supported: true,
    phase: state.phase,
    appPath: support.appPath ?? undefined,
    version: currentVersion,
  });
  scheduleReminder();
}

/** 窗口显示后调用：延迟自动检查。 */
export function scheduleAutoCheck(): void {
  if (!support.ok) return;
  setTimeout(() => void checkForUpdates(false), CHECK_DELAY_MS);
}

export function registerUpdateChannels(): void {
  ipcMain.handle(CHANNELS.updateState, () => state);
  ipcMain.handle(CHANNELS.updateCheck, (_event, manual: unknown) => checkForUpdates(manual === true));
  ipcMain.handle(CHANNELS.updateRestart, () => {
    restartToInstall();
  });
}

function messageOf(error: unknown): string {
  if (error instanceof UpdateManifestError) return t(error.key, error.params);
  return error instanceof Error ? error.message : String(error);
}
