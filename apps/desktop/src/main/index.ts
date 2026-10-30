import { app, BrowserWindow, nativeTheme, screen, session, shell } from "electron";
import { join } from "node:path";
import { attachCloseGuard, registerCloseChannels } from "./close-guard";
import { registerFileChannels, requestNewDocumentOnReady } from "./ipc";
import { mcpEndpoint } from "./mcp/endpoint";
import { registerMcpChannels, shutdownMcp, startMcp } from "./mcp";
import { logError } from "./mcp/log";
import { rebuildMenu, registerMenuChannels } from "./menu";
import { currentPreferences, initRecentFiles, requestOpen, saveWindowBounds } from "./recent-state";
import { restoreBounds } from "./window-state";

app.setName("Sqraft");
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
    if (path) requestOpen(path);
  });
}

// macOS：双击 .sqraft / 拖到 Dock 图标
app.on("open-file", (event, path) => {
  event.preventDefault();
  requestOpen(path);
});

const isDev = !app.isPackaged;

// dev 默认开调试端口：agent 可以连上来做只读的界面检查（截图 / 读 DOM），不必重启实例。
// `SQRAFT_DEBUG_PORT=0` 关闭，设成别的值就换端口；端口被占用时 Chromium 只报警，不影响启动。
if (isDev) {
  const port = process.env.SQRAFT_DEBUG_PORT ?? "9222";
  if (port !== "0") app.commandLine.appendSwitch("remote-debugging-port", port);
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
    // macOS 让红绿灯浮在左栏上；其他平台用系统标题栏并隐藏菜单栏
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    autoHideMenuBar: !isMac,
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
  if (!isDev) applyContentSecurityPolicy();
  registerFileChannels();
  registerCloseChannels();
  registerMenuChannels();
  rebuildMenu();
  registerMcpChannels();
  await initRecentFiles();
  const endpoint = mcpEndpoint(app.getPath("userData"));
  void startMcp(endpoint, app.getVersion()).catch((error: unknown) => {
    logError(null, "server start failed", {
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // 摄像头、麦克风、通知、定位等一律拒绝：本期没有任何一项需要
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  createWindow();
  const initial = pathFromArgs(process.argv);
  if (initial) requestOpen(initial);
  // 由 CLI 拉起时跳过欢迎页（07）
  if (process.argv.includes("--mcp")) requestNewDocumentOnReady();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("web-contents-created", (_event, contents) => hardenContents(contents));

app.on("before-quit", () => shutdownMcp());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
