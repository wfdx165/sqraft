/**
 * 应用菜单：标准分组结构，只放已实现的动作。
 *
 * 分工（ADR-0011 修订）：
 * - 系统级动作（退出/关闭/最小化/复制粘贴/关于）走 Electron role；
 * - 文档编辑类动作走渲染层快捷键注册表，菜单点击只发送同一个动作 id；
 * - macOS 用 accelerator 仅做展示（registerAccelerator: false），实际按键仍由渲染层处理；
 * - Windows/Linux 不注册 accelerator，把键位拼进标签，避免和渲染层抢事件。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { basename } from "node:path";
import { CHANNELS } from "../shared/ipc";
import { clearImageCache } from "./image-cache";
import { logFileDir } from "./log-file";
import { t } from "./i18n";

/** 渲染层同步过来的、面向菜单的动作键位（默认值兜底）。 */
let bindings: Record<string, string> = {};

/** 最近打开：由主进程的 recent-state 同步进来，菜单只负责展示与派发。 */
let recentFiles: string[] = [];

export function setRecentFiles(files: string[]): void {
  recentFiles = [...files];
  rebuildMenu();
}

const DEFAULT_BINDINGS: Record<string, string> = {
  "file.new": "⌘N",
  "file.closeDoc": "⌘W",
  "file.open": "⌘O",
  "file.save": "⌘S",
  "file.saveAs": "⇧⌘S",
  "file.exportPng": "⌘⇧E",
  "edit.copy": "⌘C",
  "edit.cut": "⌘X",
  "edit.undo": "⌘Z",
  "edit.redo": "⌘⇧Z",
  "view.zoomIn": "⌘+",
  "view.zoomOut": "⌘−",
  "view.zoomReset": "⌘0",
  "view.fit": "⇧1",
  "view.fitAll": "⇧2",
  "view.toggleGrid": "⌘'",
  "view.toggleSnap": "⌘⌥'",
  "view.toggleGuides": "⌘;",
};

/** `⌘⇧Z` → Electron accelerator（只用于 macOS 的展示）。 */
function toAccelerator(binding: string): string | undefined {
  if (!binding) return undefined;
  // 注意 "−" 是 U+2212，Electron 的键名是 "-"（写 Minus 会被判为无效 token）
  const map: Record<string, string> = { "⌘": "Command", "⇧": "Shift", "⌥": "Alt", "−": "-", "+": "Plus" };
  let out = "";
  for (const char of binding) out += map[char] ? `${map[char]}+` : char;
  return out.replace(/\+$/, "");
}

function keyOf(action: string): string {
  return bindings[action] ?? DEFAULT_BINDINGS[action] ?? "";
}

/**
 * 生成一个动作菜单项：macOS 显示快捷键但不注册，其他平台把键位写进标签。
 */
function actionItem(action: string, label: string, mac: boolean): MenuItemConstructorOptions {
  const accelerator = toAccelerator(keyOf(action));
  const item: MenuItemConstructorOptions = {
    label: mac || !accelerator ? label : `${label}    ${keyOf(action)}`,
    click: () => {
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      target?.webContents.send(CHANNELS.menuCommand, action);
    },
  };
  if (mac && accelerator) {
    item.accelerator = accelerator;
    item.registerAccelerator = false;
  }
  return item;
}

/** 「设置…」：macOS 快捷键 ⌘,；其他平台用 Ctrl+, 写进文件菜单。 */
function settingsItem(mac: boolean): MenuItemConstructorOptions {
  return {
    label: t("menu.settings"),
    accelerator: mac ? "Command+," : "CommandOrControl+,",
    click: () => {
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      target?.webContents.send(CHANNELS.menuCommand, "app.settings");
    },
  };
}

/** 「配置 MCP…」：入口归到应用菜单的「设置…」旁边（非 mac 放「文件」菜单）。 */
function mcpSetupItem(): MenuItemConstructorOptions {
  return {
    label: t("menu.configureMcp"),
    click: () => {
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      target?.webContents.send(CHANNELS.menuCommand, "app.mcpSetup");
    },
  };
}

/**
 * 「关闭窗口」：显式绑定 ⇧⌘W。
 * 绝不能用 `role: "close"`——它自带 Cmd/Ctrl+W 并直接注册，会在渲染层之前吃掉 ⌘W，
 * 而 ⌘W 属于"关闭文档回欢迎页"（渲染层注册表）。
 */
function closeWindowItem(label: string): MenuItemConstructorOptions {
  return {
    label,
    accelerator: "CommandOrControl+Shift+W",
    click: () => {
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      target?.close();
    },
  };
}

export interface TemplateOptions {
  /** 是否显示「开发者工具」：只有未打包运行（`pnpm dev`）才给，安装包里不出现 */
  showDevTools?: boolean;
}

/** 开发者工具：右侧停靠，再点一次关闭（与 Chrome 一致）。 */
function devToolsMenuItem(mac: boolean): MenuItemConstructorOptions {
  return {
    label: t("menu.devTools"),
    // Windows/Linux 不用 Ctrl+Shift+I：渲染层把 ctrlKey 当 ⌘，那个组合是「插入图片」
    accelerator: mac ? "Command+Alt+I" : "F12",
    click: () => {
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!target) return;
      const contents = target.webContents;
      if (contents.isDevToolsOpened()) contents.closeDevTools();
      else contents.openDevTools({ mode: "right" });
    },
  };
}

export function buildTemplate(
  platform: NodeJS.Platform = process.platform,
  options: TemplateOptions = {},
): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const showDevTools = options.showDevTools ?? false;
  const template: MenuItemConstructorOptions[] = [];

  if (mac) {
    template.push({
      label: app.name,
      submenu: [
        {
          label: t("menu.about"),
          click: () => {
            const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            target?.webContents.send(CHANNELS.menuCommand, "app.about");
          },
        },
        settingsItem(mac),
        mcpSetupItem(),
        { type: "separator" },
        { role: "services", label: t("menu.services") },
        { type: "separator" },
        { role: "hide", label: t("menu.hideApp") },
        { role: "hideOthers", label: t("menu.hideOthers") },
        { role: "unhide", label: t("menu.showAll") },
        { type: "separator" },
        { role: "quit", label: t("menu.quitApp") },
      ],
    });
  }

  template.push({
    label: t("menu.file"),
    submenu: [
      actionItem("file.new", t("menu.new"), mac),
      actionItem("file.open", t("menu.open"), mac),
      actionItem("file.insertImage", t("menu.insertImage"), mac),
      actionItem("file.save", t("menu.save"), mac),
      actionItem("file.saveAs", t("menu.saveAs"), mac),
      actionItem("file.exportPng", t("menu.exportPng"), mac),
      { type: "separator" },
      ...(mac ? [] : [settingsItem(mac), mcpSetupItem()]),
      ...(mac ? [] : [{ type: "separator" as const }]),
      {
        // 链接图片的字节不在文件里，只能靠本机缓存：给一个手动清理入口（上限 500MB，LRU 自动淘汰）
        label: t("menu.clearImageCache"),
        click: () => {
          void (async () => {
            const bytes = await clearImageCache();
            const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            const options: Electron.MessageBoxOptions = {
              type: "info",
              buttons: [t("common.ok")],
              message:
                bytes > 0
                  ? t("menu.imageCacheCleared", { mb: Math.max(1, Math.round(bytes / 1024 / 1024)) })
                  : t("menu.imageCacheEmpty"),
            };
            if (target) await dialog.showMessageBox(target, options);
            else await dialog.showMessageBox(options);
          })();
        },
      },
      { type: "separator" },
      {
        label: t("menu.openRecent"),
        submenu:
          recentFiles.length === 0
            ? [{ label: t("menu.noRecent"), enabled: false }]
            : recentFiles.map((path) => ({
                label: basename(path),
                click: () => {
                  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
                  target?.webContents.send(CHANNELS.fileOpenRequest, path);
                },
              })),
      },
      { type: "separator" },
      actionItem("file.closeDoc", t("menu.closeDoc"), mac),
      { type: "separator" },
      closeWindowItem(t("menu.closeWindow")),
      ...(mac ? [] : [{ role: "quit" as const, label: t("menu.quit") }]),
    ],
  });

  template.push({
    label: t("menu.edit"),
    submenu: [
      actionItem("edit.undo", t("menu.undo"), mac),
      actionItem("edit.redo", t("menu.redo"), mac),
      { type: "separator" },
      actionItem("edit.cut", t("menu.cut"), mac),
      actionItem("edit.copy", t("menu.copy"), mac),
      actionItem("edit.paste", t("menu.paste"), mac),
      actionItem("edit.selectAll", t("menu.selectAll"), mac),
    ],
  });

  template.push({
    label: t("menu.view"),
    submenu: [
      actionItem("view.zoomIn", t("menu.zoomIn"), mac),
      actionItem("view.zoomOut", t("menu.zoomOut"), mac),
      actionItem("view.zoomReset", t("menu.zoomReset"), mac),
      { type: "separator" },
      actionItem("view.fit", t("menu.fit"), mac),
      actionItem("view.fitAll", t("menu.fitAll"), mac),
      { type: "separator" },
      actionItem("view.toggleGrid", t("menu.showGrid"), mac),
      actionItem("view.toggleSnap", t("menu.enableSnap"), mac),
      actionItem("view.toggleGuides", t("menu.showGuides"), mac),
      { type: "separator" },
      { role: "togglefullscreen", label: t("menu.enterFullscreen") },
    ],
  });

  template.push({
    label: t("menu.window"),
    submenu: mac
      ? [
          { role: "minimize", label: t("menu.minimize") },
          { role: "zoom", label: t("menu.zoom") },
          { type: "separator" },
          { role: "front", label: t("menu.bringAllToFront") },
        ]
      : [
          { role: "minimize", label: t("menu.minimize") },
          // 不带 accelerator：⇧⌘W 已在"文件"里注册，注册两次会互相抢
          {
            label: t("menu.close"),
            click: () => {
              const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
              target?.close();
            },
          },
        ],
  });

  const help: MenuItemConstructorOptions[] = [
    {
      // 更新是半静默的（ADR-0029）：自动检查之外，给一个"我现在就想查"的入口
      label: t("menu.checkUpdates"),
      click: () => {
        const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        target?.webContents.send(CHANNELS.menuCommand, "app.checkUpdates");
      },
    },
    {
      // 打包版从 Finder 启动时日志只落文件，入口要能被找到
      label: t("menu.openLogs"),
      click: () => {
        const dir = logFileDir();
        if (dir) void shell.openPath(dir);
      },
    },
  ];
  if (showDevTools) help.push({ type: "separator" }, devToolsMenuItem(mac));
  help.push(
    { type: "separator" },
    {
      label: t("menu.about"),
      click: () => {
        const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        target?.webContents.send(CHANNELS.menuCommand, "app.about");
      },
    },
  );

  template.push({ label: t("menu.help"), submenu: help });

  return template;
}

export function rebuildMenu(): void {
  // 开发者工具只在未打包运行时给（安装包里不出现）
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(process.platform, { showDevTools: !app.isPackaged })));
}

export function registerMenuChannels(): void {
  ipcMain.on(CHANNELS.menuSetBindings, (_event, next: Record<string, string>) => {
    bindings = { ...next };
    rebuildMenu();
  });
}
