import { app, BrowserWindow, nativeTheme, screen, session, shell } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { legacyDotDirOf, migrateFromLegacyDotDir, relocateImageCache, userDataDirOf } from "./data-dir";
import { attachCloseGuard, registerCloseChannels } from "./close-guard";
import { registerFileChannels } from "./ipc";
import { registerImageCacheChannels } from "./image-cache";
import { registerMcpChannels, shutdownMcp, startMcp } from "./mcp";
import { logApp } from "./mcp/log";
import { removeStaleCliLink } from "./mcp/setup";
import { initLogFile } from "./log-file";
import { rebuildMenu, registerMenuChannels } from "./menu";
import { initMainI18n } from "./i18n";
import { currentPreferences, initRecentFiles, requestOpen, saveWindowBounds } from "./recent-state";
import { initUpdater, installOnQuit, registerUpdateChannels, scheduleAutoCheck } from "./updater";
import { restoreBounds } from "./window-state";

app.setName("Sqraft");

// 数据目录走平台惯例的 userData（macOS `~/Library/Application Support/Sqraft`，见 data-dir.ts）：
// 必须在 app ready 之前改，之后的 getPath 才走新目录；dev 与打包版共用同一目录。
const targetUserData = userDataDirOf(app.getPath("appData"));
const targetLogs = app.getPath("logs");
const legacyDotDir = legacyDotDirOf(homedir());
app.setPath("userData", targetUserData);
// 一次性迁移旧家目录点目录：同步执行，必须早于日志与任何 Chromium 存储访问
// （Local Storage 里存着用户自定义快捷键，要在渲染层起来之前搬过去）
const migration = migrateFromLegacyDotDir({ legacy: legacyDotDir, target: targetUserData, logs: targetLogs });
// 早期构建把链接图缓存放进了 Chromium 的 `Cache/images`（大小写不敏感卷上同一目录）：
// 独立于迁移标记、每次启动检查一次，没有旧目录就是 no-op
const relocated = relocateImageCache(targetUserData);
// 日志最先初始化：启动早期的失败（数据目录不可写等）也要留下线索
initLogFile({ dir: targetLogs });
if (migration.status === "failed") {
  process.stderr?.write(`[log] data dir migration failed: ${migration.error}\n`);
  // 打包版从 Finder 启动时 stderr 没有出口：失败必须同时在文件日志里留痕
  logApp("error", "data dir migration failed", {
    from: legacyDotDir,
    to: targetUserData,
    error: migration.error,
  });
} else if (migration.status === "migrated") {
  logApp("info", "data dir migrated", { from: legacyDotDir, to: targetUserData, moved: migration.moved });
}
if (relocated) logApp("info", "image cache relocated", relocated);
// 应用固定浅色：连原生菜单、标题栏、系统弹窗也不要跟随系统深色
nativeTheme.themeSource = "light";

/** 从命令行参数里挑出要打开的 `.sqraft`（Windows/Linux 双击文件走这里）。 */
function pathFromArgs(argv: readonly string[]): string | null {
  const candidate = argv.find((arg) => /\.sqraft$/i.test(arg));
  return candidate ?? null;
}

function focusMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}

// 单实例：第二次启动只聚焦已有窗口，并把要打开的文件转发过去
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    focusMainWindow();
    const path = pathFromArgs(argv);
    logApp("info", "second instance", { path: path ?? undefined });
    if (path) requestOpen(path);
  });
}

// macOS：双击 .sqraft / 拖到 Dock 图标
app.on("open-file", (event, path) => {
  event.preventDefault();
  logApp("info", "open-file event", { path });
  requestOpen(path);
});

const isDev = !app.isPackaged;

// dev 默认**不开**调试端口：本机任何进程都能连上来控制渲染层。
// 需要做只读界面检查（截图 / 读 DOM）时显式开：`SQRAFT_DEBUG_PORT=9222 pnpm dev`。
// 端口被占用时 Chromium 只报警，不影响启动。
if (isDev) {
  const port = process.env.SQRAFT_DEBUG_PORT;
  if (port && port !== "0") app.commandLine.appendSwitch("remote-debugging-port", port);
}

/** 生产构建的 CSP：只允许应用自身资源，脚本不接受 eval。 */
function applyContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'",
        ],
      },
    });
  });
}

/** 只允许 http/https 外部链接，且交给系统浏览器打开。 */
function isSafeExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * 渲染层就是一个纯 Web 页面：禁止它自我导航到别处，禁止它开新窗口。
 * 需要打开链接时走系统浏览器，避免应用本身变成任意页面的宿主。
 */
function hardenContents(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    const current = contents.getURL();
    // 开发态允许 Vite 的整页刷新（同源同路径），其余一律拦截
    if (url === current) return;
    if (isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "\u0000")) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });
}

function createWindow(): void {
  const bounds = restoreBounds(
    currentPreferences().window,
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const isMac = process.platform === "darwin";
  const window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "Sqraft",
    backgroundColor: "#eef0f4",
    // macOS 让红绿灯浮在左栏上；Windows / Linux 用系统标题栏并常显菜单栏——
    // 隐藏后只有 Alt 能唤起，"打开日志目录""清空图片缓存"这类排障入口等于找不到
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  window.once("ready-to-show", () => {
    // 启动铺满"上次窗口所在那块屏"的工作区（产品决定，不是 macOS 全屏模式）：
    // 先设尺寸再 show，避免先闪一下小窗。菜单栏与 Dock 仍在，绿灯是普通状态。
    const area = screen.getDisplayMatching({
      x: bounds.x ?? 0,
      y: bounds.y ?? 0,
      width: bounds.width,
      height: bounds.height,
    }).workArea;
    window.setBounds(area);
    window.show();
  });
  attachCloseGuard(window);
  logApp("info", "window created", { width: bounds.width, height: bounds.height });
  window.on("closed", () => logApp("info", "window closed"));

  // 记住窗口位置：拖动/缩放时防抖写盘，关闭前再兜一次
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const normal = window.getNormalBounds();
      void saveWindowBounds({ ...normal, maximized: window.isMaximized() });
    }, 400);
  };
  window.on("resize", persistBounds);
  window.on("move", persistBounds);
  window.on("close", () => {
    if (saveTimer) clearTimeout(saveTimer);
    const normal = window.getNormalBounds();
    void saveWindowBounds({ ...normal, maximized: window.isMaximized() });
  });

  // 启动铺满工作区：不再走"上次最大化"这条路（尺寸在 ready-to-show 里统一设置）

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (isDev && devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  logApp("info", "app ready", {
    version: app.getVersion(),
    // 字段名刻意中性（排障仍要版本值）：日志由帮助菜单「打开日志目录」直达，不往外带 Electron 字样
    runtime: process.versions.electron,
    engine: process.versions.chrome,
    platform: process.platform,
    packaged: app.isPackaged,
  });
  if (!isDev) applyContentSecurityPolicy();
  registerFileChannels();
  registerImageCacheChannels();
  registerCloseChannels();
  registerMenuChannels();
  registerMcpChannels();
  await initRecentFiles();
  // 偏好里没有 language 时按 auto；解析出实际语言后再建一次菜单
  initMainI18n(currentPreferences().language ?? "auto");
  rebuildMenu();
  // 更新器依赖偏好（节流时间、已下载版本），必须排在 initRecentFiles 之后
  await initUpdater();
  registerUpdateChannels();
  installOnQuit();
  // 旧版本装过 sqraft-mcp 软链：升级后目标文件已删，能确认是本应用留下的就清掉
  void removeStaleCliLink({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  }).then((removed) => {
    if (removed.length > 0) logApp("info", "legacy cli link removed", { paths: removed.join(", ") });
  }).catch((error: unknown) => {
    logApp("error", "legacy cli cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  void startMcp(app.getVersion());
  // 摄像头、麦克风、通知、定位等一律拒绝：本期没有任何一项需要
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  createWindow();
  scheduleAutoCheck();
  const initial = pathFromArgs(process.argv);
  if (initial) requestOpen(initial);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("web-contents-created", (_event, contents) => hardenContents(contents));

app.on("before-quit", () => {
  logApp("info", "before-quit");
  shutdownMcp();
});

app.on("window-all-closed", () => {
  logApp("info", "window-all-closed", { platform: process.platform });
  if (process.platform !== "darwin") app.quit();
});
