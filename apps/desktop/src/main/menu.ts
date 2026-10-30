/**
 * 应用菜单：五组标准结构，只放已实现的动作。
 *
 * 分工（ADR-0011 修订）：
 * - 系统级动作（退出/关闭/最小化/复制粘贴/关于）走 Electron role；
 * - 文档编辑类动作走渲染层快捷键注册表，菜单点击只发送同一个动作 id；
 * - macOS 用 accelerator 仅做展示（registerAccelerator: false），实际按键仍由渲染层处理；
 * - Windows/Linux 不注册 accelerator，把键位拼进标签，避免和渲染层抢事件。
 */
import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from "electron";
import { basename } from "node:path";
import { CHANNELS } from "../shared/ipc";

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
  "edit.undo": "⌘Z",
  "edit.redo": "⌘⇧Z",
  "view.zoomIn": "⌘+",
  "view.zoomOut": "⌘−",
  "view.zoomReset": "⌘0",
  "view.fit": "⇧1",
  "view.fitAll": "⇧2",
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

export function buildTemplate(platform: NodeJS.Platform = process.platform): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const template: MenuItemConstructorOptions[] = [];

  if (mac) {
    template.push({
      label: app.name,
      submenu: [
        {
          label: "关于 Sqraft",
          click: () => {
            const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            target?.webContents.send(CHANNELS.menuCommand, "app.about");
          },
        },
        { type: "separator" },
        { role: "services", label: "服务" },
        { type: "separator" },
        { role: "hide", label: "隐藏 Sqraft" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: "退出 Sqraft" },
      ],
    });
  }

  template.push({
    label: "文件",
    submenu: [
      actionItem("file.new", "新建", mac),
      actionItem("file.open", "打开…", mac),
      actionItem("file.save", "保存", mac),
      actionItem("file.saveAs", "另存为…", mac),
      { type: "separator" },
      {
        label: "打开最近",
        submenu:
          recentFiles.length === 0
            ? [{ label: "（暂无）", enabled: false }]
            : recentFiles.map((path) => ({
                label: basename(path),
                click: () => {
                  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
                  target?.webContents.send(CHANNELS.fileOpenRequest, path);
                },
              })),
      },
      { type: "separator" },
      actionItem("file.closeDoc", "关闭文档", mac),
      { type: "separator" },
      closeWindowItem("关闭窗口"),
      ...(mac ? [] : [{ role: "quit" as const, label: "退出" }]),
    ],
  });

  template.push({
    label: "编辑",
    submenu: [
      actionItem("edit.undo", "撤销", mac),
      actionItem("edit.redo", "重做", mac),
      { type: "separator" },
      { role: "cut", label: "剪切" },
      { role: "copy", label: "复制" },
      { role: "paste", label: "粘贴" },
      { role: "selectAll", label: "全选" },
    ],
  });

  template.push({
    label: "视图",
    submenu: [
      actionItem("view.zoomIn", "放大", mac),
      actionItem("view.zoomOut", "缩小", mac),
      actionItem("view.zoomReset", "实际大小", mac),
      { type: "separator" },
      actionItem("view.fit", "适配页面", mac),
      actionItem("view.fitAll", "查看全部页面", mac),
      { type: "separator" },
      { role: "togglefullscreen", label: "进入全屏幕" },
    ],
  });

  template.push({
    label: "窗口",
    submenu: mac
      ? [
          { role: "minimize", label: "最小化" },
          { role: "zoom", label: "缩放" },
          { type: "separator" },
          { role: "front", label: "全部置于顶层" },
        ]
      : [
          { role: "minimize", label: "最小化" },
          // 不带 accelerator：⇧⌘W 已在"文件"里注册，注册两次会互相抢
          {
            label: "关闭",
            click: () => {
              const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
              target?.close();
            },
          },
        ],
  });

  template.push({
    label: "帮助",
    submenu: [
      {
        label: "配置 MCP…",
        click: () => {
          const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          target?.webContents.send(CHANNELS.menuCommand, "app.mcpSetup");
        },
      },
      { type: "separator" },
      {
        label: "关于 Sqraft",
        click: () => {
          const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          target?.webContents.send(CHANNELS.menuCommand, "app.about");
        },
      },
    ],
  });

  return template;
}

export function rebuildMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()));
}

export function registerMenuChannels(): void {
  ipcMain.on(CHANNELS.menuSetBindings, (_event, next: Record<string, string>) => {
    bindings = { ...next };
    rebuildMenu();
  });
}
