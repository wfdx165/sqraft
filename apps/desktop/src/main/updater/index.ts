/**
 * 更新器：半静默（ADR-0029 / ADR-0033）。
 *
 * - 启动后延迟 5 秒检查一次；运行期每 4 小时轮询一次，系统唤醒后补查；失败静默，只写日志。
 * - macOS arm64：有新版本就后台下载 zip、校验 sha256，进入"已就绪"；
 *   退出时由 detached 脚本替换 `Sqraft.app`；就绪满 7 天提醒一次，永不强制重启。
 * - Windows：只检查版本，状态置为 `available`，界面引导去下载页；不下载、不安装。
 * - 开发态与其他平台：`mode: none`，连检查都不做。
 * - 不做 beta 通道、不做"跳过此版本"、不签名。
 *
 * 状态判定（该不该查、查到后做什么、启动时恢复成什么）都在 `decisions.ts` /
 * `reconcile.ts` 里，本文件只做 Electron / 网络 / 文件系统胶水。
 */
import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } from "electron";
import { basename, join } from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { CHANNELS, type UpdateState } from "../../shared/ipc";
import { logApp } from "../mcp/log";
import { patchUpdatePreferences, updatePreferences } from "../recent-state";
import { isCheckBlocked, nextPollDelay, planForLatest, POLL_INTERVAL_MS, reminderDelay, shouldCheck } from "./decisions";
import { downloadVerified } from "./download";
import { installPathsOf, resolveInstallSupport, signingTeamOf, spawnInstallerSync, type InstallSupport } from "./install";
import { t } from "../i18n";
import { reconcileOnStart } from "./reconcile";
import { isTrustedUpdateUrl, parseLatest, UpdateManifestError } from "./protocol";
// 发布仓库的唯一真源：`scripts/release.mjs` 读同一份配置，避免脚本和客户端指向不同仓库
import updateConfig from "../../../update.config.json";
import type { UpdateAsset } from "./protocol";

export const UPDATE_REPO = updateConfig.repo;

const LATEST_URL = `https://github.com/${UPDATE_REPO}/releases/latest/download/latest.json`;
/** Windows 没有自替换：只把用户送到发布页手动下载 */
const DOWNLOAD_PAGE_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;
/** 启动后延迟检查：不和窗口首帧、MCP 启动抢资源 */
const CHECK_DELAY_MS = 5_000;
/** 系统唤醒后补查的延迟：等网络栈与代理恢复，别在刚醒来的瞬间就超时 */
const RESUME_DELAY_MS = 30_000;
/** 自动下载前最多等窗口失焦这么久；等不到就直接下 */
const IDLE_BEFORE_DOWNLOAD_MS = 30 * 60_000;

/** 这次检查是谁触发的：日志里要能区分，不然"14:19 那次是谁查的"只能靠猜 */
export type CheckCause = "manual" | "startup" | "poll" | "resume";

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
  autoDownload: true,
};

let support: InstallSupport = { mode: "none", reason: "", appPath: null };
let checkInFlight: Promise<UpdateState> | null = null;
let initialized = false;
/** 运行期轮询的链式定时器：同一时间最多一个，避免慢检查叠出多条链 */
let pollTimer: ReturnType<typeof setTimeout> | null = null;
/** 本进程内最后一次检查的发起时间：检查失败不写 `lastCheckAt`，轮询对齐要靠它 */
let lastAttemptAt = 0;
/** 7 天提醒的定时器：进入 ready 与启动恢复各排一次，重排前先清旧的 */
let reminderTimer: ReturnType<typeof setTimeout> | null = null;
/** 等待窗口失焦期间挂着的监听：重排时先摘掉，避免叠加成多次弹窗 */
let reminderWait: (() => void) | null = null;
let pollingStarted = false;

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
  // 就绪可能是"运行期轮询"发现的：不重启也要在 7 天后提醒，所以这里补排一次
  scheduleReminder();
}

/**
 * 自动下载前等窗口失焦：不抢用户正在用的带宽；最多等 30 分钟。
 * 手动检查不走这里——用户明确要求下载，立刻开始。
 */
async function waitForIdle(): Promise<void> {
  const focused = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused());
  if (!focused) return;
  // 只有真的需要等时才把状态切成 waiting，避免"一闪而过"
  publish({ phase: "waiting", progress: 0 });
  logApp("info", "update: download deferred until idle");
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      app.off("browser-window-blur", finish);
      app.off("window-all-closed", finish);
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, IDLE_BEFORE_DOWNLOAD_MS);
    app.on("browser-window-blur", finish);
    // 关掉所有窗口（macOS 应用不退）也算"不在操作"
    app.on("window-all-closed", finish);
  });
}

async function runCheck(manual: boolean, cause: CheckCause): Promise<UpdateState> {
  const started = Date.now();
  // 轮询对齐用：失败不写 lastCheckAt，但下一次尝试也不能立刻重来
  lastAttemptAt = started;
  publish({ phase: "checking", message: null, progress: 0 });
  try {
    const manifest = parseLatest(await fetchLatest());
    await patchUpdatePreferences({ lastCheckAt: Date.now() }).catch(() => undefined);
    const plan = planForLatest({
      currentVersion: app.getVersion(),
      manifest,
      failedVersion: updatePreferences().failedVersion ?? null,
      manual,
      installable: support.mode === "install",
      autoDownload: state.autoDownload,
    });

    if (plan.kind === "up-to-date") {
      logApp("info", "update: up to date", {
        version: app.getVersion(),
        latest: plan.version,
        cause,
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
      logApp("warn", "update: skipped previously failed version", { version: plan.version, cause });
      return publish({ phase: "idle", message: null });
    }

    if (plan.kind === "available") {
      logApp("info", "update: available, manual download only", { version: plan.version, cause });
      return publish({
        phase: "available",
        latestVersion: plan.version,
        notes: plan.notes,
        publishedAt: plan.publishedAt,
      });
    }

    logApp("info", "update: new version", {
      current: app.getVersion(),
      latest: plan.version,
      cause,
    });
    publish({ latestVersion: plan.version, notes: plan.notes, publishedAt: plan.publishedAt });
    // 自动下载等窗口失焦再开始：别在用户正在操作时抢带宽（手动检查直接下）
    if (cause !== "manual") {
      await waitForIdle();
      // 等待期间关掉了自动下载：改回"只提示"，等下次检查再决定
      if (!state.autoDownload) {
        logApp("info", "update: auto download cancelled", { version: plan.version });
        return publish({ phase: "available" });
      }
    }
    await downloadUpdate(plan.version, plan.asset);
    logApp("info", "update: ready", { version: plan.version, cause, ms: Date.now() - started });
    return state;
  } catch (error) {
    const message = messageOf(error);
    logApp(manual ? "warn" : "info", "update: check failed", { cause, error: message, ms: Date.now() - started });
    // 自动检查失败对用户不可见；手动检查必须给出原因
    if (manual) return publish({ phase: "error", message });
    return publish({ phase: "idle", message: null });
  }
}

/** 检查更新。`manual` 忽略最小检查间隔，并把失败原因留在状态里。 */
export async function checkForUpdates(
  manual = false,
  cause: CheckCause = manual ? "manual" : "poll",
): Promise<UpdateState> {
  if (support.mode === "none") return state;
  if (checkInFlight) return checkInFlight;
  if (!shouldCheck({ prefs: updatePreferences(), manual, phase: state.phase, now: Date.now() })) return state;
  checkInFlight = runCheck(manual, cause).finally(() => {
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

/**
 * 就绪满 7 天后主动提醒一次（同一版本只提醒一次），不强制重启。
 *
 * 定时器按"到期时间 − 现在"排，而不是只在启动时判断一次：运行期轮询拿到的就绪
 * 也要能被提醒（应用可能开着好几天不重启）。重排前先清旧定时器。
 * 到点时如果用户正在应用里操作，等窗口失焦再弹——不在拖拽 / 演示中抢焦点。
 */
function scheduleReminder(): void {
  clearReminderWait();
  const prefs = updatePreferences();
  if (state.phase !== "ready" || !state.latestVersion || !prefs.readySince) return;
  if (prefs.remindedVersion === state.latestVersion) return;
  if (reminderTimer) clearTimeout(reminderTimer);
  reminderTimer = setTimeout(() => {
    reminderTimer = null;
    if (state.phase !== "ready" || !state.latestVersion) return;
    const version = state.latestVersion;
    const focused = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused());
    if (!focused) {
      showReminder(version);
      return;
    }
    clearReminderWait();
    const wait = (): void => {
      clearReminderWait();
      showReminder(version);
    };
    reminderWait = wait;
    app.on("browser-window-blur", wait);
    // 关掉所有窗口（macOS 应用不退）也算"不在操作"
    app.on("window-all-closed", wait);
  }, reminderDelay({ readySince: prefs.readySince, now: Date.now() }));
}

function clearReminderWait(): void {
  if (!reminderWait) return;
  app.off("browser-window-blur", reminderWait);
  app.off("window-all-closed", reminderWait);
  reminderWait = null;
}

/** 真正弹窗：写提醒去重标记，再走一次「现在重启 / 稍后」。 */
function showReminder(version: string): void {
  if (state.phase !== "ready" || state.latestVersion !== version) return;
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
    if (state.phase !== "ready" || support.mode !== "install" || !state.latestVersion) return;
    try {
      spawnInstallerSync({
        ...paths(),
        pid: process.pid,
        version: state.latestVersion,
        appName: basename(support.appPath ?? "Sqraft.app"),
        // 替换前让脚本校验新包签名与 Team（ADR-0034）；旧版本未签名时为空串，脚本跳过
        expectedTeam: support.appPath ? signingTeamOf(support.appPath) : "",
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
  const autoDownload = updatePreferences().autoDownload ?? true;
  state = { ...state, autoDownload };
  if (support.mode === "none") {
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

  // Windows：只有检查与提示，没有下载、替换与回滚，所以不碰启动标记和 reconcile
  if (support.mode === "notify") {
    state = { ...state, currentVersion, supported: true };
    logApp("info", "update: initialized (notify only)", { version: currentVersion });
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
  // reconcile 会重建整个状态对象：把与安装无关的偏好补回去
  state = { ...state, autoDownload };
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

/**
 * 运行期轮询：链式 setTimeout，上一次检查彻底结束后才排下一次。
 * 用 setInterval 会在下载 120MB 时叠出多轮 tick；`checkForUpdates` 的
 * `checkInFlight` 只保证不并发，不保证不堆积。
 *
 * 就绪后直接停链：不可能再查出新版本（安装在退出时发生），继续排只是空转。
 * 下载中也不排——正在飞的那次检查的 `.finally` 会在结束后接手（成功 → ready → 停，
 * 失败 → idle → 继续排）。
 */
function schedulePoll(): void {
  if (pollTimer || isCheckBlocked(state.phase)) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void checkForUpdates(false, "poll").finally(schedulePoll);
  }, nextPollDelay({ lastCheckAt: updatePreferences().lastCheckAt, lastAttemptAt, now: Date.now() }));
}

/** 检查刚跑过（启动 / 唤醒）时重排：清掉按旧锚点排的 tick，按新的上次尝试对齐。 */
function reschedulePoll(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  schedulePoll();
}

/** 唤醒后补查：合盖一夜回来不该等下一个 4 小时窗口。 */
function watchResume(): void {
  powerMonitor.on("resume", () => {
    if (support.mode === "none") return;
    setTimeout(() => void checkForUpdates(false, "resume").finally(reschedulePoll), RESUME_DELAY_MS);
  });
}

/** 窗口显示后调用：启动后查一次，并开始运行期轮询（重复调用无副作用）。 */
export function scheduleAutoCheck(): void {
  if (support.mode === "none" || pollingStarted) return;
  pollingStarted = true;
  logApp("info", "update: poll started", { intervalMs: POLL_INTERVAL_MS });
  setTimeout(() => void checkForUpdates(false, "startup").finally(schedulePoll), CHECK_DELAY_MS);
  watchResume();
}

/** Windows：把用户送到发布页；不做下载与安装。打不开系统浏览器时返回 false，由界面提示。 */
export async function openDownloadPage(): Promise<boolean> {
  logApp("info", "update: open download page", { version: state.latestVersion ?? undefined });
  try {
    await shell.openExternal(DOWNLOAD_PAGE_URL);
    return true;
  } catch (error) {
    logApp("warn", "update: open download page failed", { error: messageOf(error) });
    return false;
  }
}

/** 自动下载开关：写偏好并立刻反映到状态（下次检查生效；不会中断已开始的下载）。 */
export async function setAutoDownload(enabled: boolean): Promise<UpdateState> {
  await patchUpdatePreferences({ autoDownload: enabled }).catch((error: unknown) => {
    logApp("warn", "update: auto download persist failed", { error: messageOf(error) });
  });
  logApp("info", "update: auto download changed", { enabled });
  return publish({ autoDownload: enabled });
}

export function registerUpdateChannels(): void {
  ipcMain.handle(CHANNELS.updateState, () => state);
  ipcMain.handle(CHANNELS.updateCheck, (_event, manual: unknown) =>
    checkForUpdates(manual === true, manual === true ? "manual" : "poll"),
  );
  ipcMain.handle(CHANNELS.updateRestart, () => {
    restartToInstall();
  });
  ipcMain.handle(CHANNELS.updateDownload, () => openDownloadPage());
  ipcMain.handle(CHANNELS.updateSetAutoDownload, (_event, enabled: unknown) => setAutoDownload(enabled === true));
}

function messageOf(error: unknown): string {
  if (error instanceof UpdateManifestError) return t(error.key, error.params);
  return error instanceof Error ? error.message : String(error);
}
