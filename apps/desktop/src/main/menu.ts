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
import { CHANNELS, type MenuState } from "../shared/ipc";
import { formatBinding } from "../shared/binding";
import { commandOf, COMMANDS, isCommandId, type CommandId } from "../shared/commands";
import { clearImageCache } from "./image-cache";
import { logFileDir } from "./log-file";
import { t } from "./i18n";
import { logApp } from "./mcp/log";

/** 渲染层同步过来的、面向菜单的动作键位（默认值兜底）。 */
let bindings: Record<string, string> = {};

/** 最近打开：由主进程的 recent-state 同步进来，菜单只负责展示与派发。 */
let recentFiles: string[] = [];

/**
 * 会话状态（渲染层推送）：没有文档时大部分动作无处落地，演示中渲染层会丢弃所有动作。
 * 菜单要跟这个状态一致，否则点下去只是静默失败。
 */
let menuState: MenuState = { docOpen: false, presenting: false };

/**
 * 即使没有文档也保持可用的菜单项：它们先判断焦点是否在输入框，走原生 `execCommand`。
 * 设置面板里的输入框在欢迎页也会用到，禁掉就没法复制粘贴文字了。
 */
const MENU_ALWAYS_ENABLED: ReadonlySet<CommandId> = new Set([
  "edit.copy",
  "edit.cut",
  "edit.paste",
  "edit.selectAll",
]);

/** 状态变了才重建菜单（重建会关掉正在展开的原生菜单，别每帧都做）。 */
export function setMenuState(next: MenuState): void {
  const docOpen = next.docOpen === true;
  const presenting = next.presenting === true;
  if (docOpen === menuState.docOpen && presenting === menuState.presenting) return;
  menuState = { docOpen, presenting };
  rebuildMenu();
}

export function setRecentFiles(files: string[]): void {
  recentFiles = [...files];
  rebuildMenu();
}

/** 默认键位只有一份：注册表。 */
const DEFAULT_BINDINGS: Record<string, string> = Object.fromEntries(
  COMMANDS.flatMap((command) => (command.default ? [[command.id, command.default]] : [])),
);

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

/** 菜单项是否可点：演示模式优先，其次看是否需要文档。 */
function isMenuEnabled(action: CommandId): boolean {
  if (menuState.presenting && action !== "view.present") return false;
  if (MENU_ALWAYS_ENABLED.has(action)) return true;
  return menuState.docOpen || commandOf(action).requires !== "doc";
}

/**
 * 生成一个动作菜单项：macOS 显示快捷键但不注册，其他平台把键位写进标签。
 * 文案来自注册表（`menuLabelKey` 优先），不再由调用方各传一份。
 */
function actionItem(action: CommandId, mac: boolean): MenuItemConstructorOptions {
  const command = commandOf(action);
  const label = t(command.menuLabelKey ?? command.labelKey);
  const accelerator = toAccelerator(keyOf(action));
  const item: MenuItemConstructorOptions = {
    // 演示中除「演示」外全灰；没有文档时 requires:"doc" 的项灰掉
    enabled: isMenuEnabled(action),
    // 非 mac 把键位写进标签；Windows 显示 Ctrl/Alt/Shift，不能把 ⌘ 直接甩给用户
    label: mac || !accelerator ? label : `${label}    ${formatBinding(keyOf(action), mac ? "darwin" : "win32")}`,
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
    label: t(commandOf("app.settings").labelKey),
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
    label: t(commandOf("app.mcpSetup").labelKey),
    click: () => {
      const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      target?.webContents.send(CHANNELS.menuCommand, "app.mcpSetup");
    },
  };
}

/** 清图片缓存 + 结果对话框；菜单与 ⌘K 共用。 */
async function clearImageCacheWithDialog(): Promise<void> {
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
}

async function openLogsDir(): Promise<void> {
  const dir = logFileDir();
  if (dir) await shell.openPath(dir);
}

/**
 * 主进程专属命令的统一入口（⌘K 走 `app:run-command`）。
 * UI 类命令回发给渲染层，走与菜单点击完全相同的路径；文件/日志类命令在主进程执行。
 */
export async function runMainCommand(id: CommandId): Promise<boolean> {
  if (commandOf(id).owner !== "main") return false;
  if (id === "app.clearImageCache") {
    await clearImageCacheWithDialog();
    return true;
  }
  if (id === "app.openLogsDir") {
    await openLogsDir();
    return true;
  }
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!target) return false;
  target.webContents.send(CHANNELS.menuCommand, id);
  return true;
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
          label: t(commandOf("app.about").labelKey),
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
      actionItem("file.new", mac),
      actionItem("file.open", mac),
      actionItem("file.insertImage", mac),
      actionItem("file.save", mac),
      actionItem("file.saveAs", mac),
      {
        label: t("menu.exportAs"),
        enabled: menuState.docOpen && !menuState.presenting,
        submenu: [
          actionItem("file.exportPng1", mac),
          actionItem("file.exportPng2", mac),
          actionItem("file.exportPng4", mac),
          actionItem("file.exportSvg", mac),
          actionItem("file.exportMatrix", mac),
        ],
      },
      { type: "separator" },
      ...(mac ? [] : [settingsItem(mac), mcpSetupItem()]),
      ...(mac ? [] : [{ type: "separator" as const }]),
      {
        // 链接图片的字节不在文件里，只能靠本机缓存：给一个手动清理入口（上限 500MB，LRU 自动淘汰）
        label: t(commandOf("app.clearImageCache").labelKey),
        click: () => {
          void clearImageCacheWithDialog();
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
      actionItem("file.closeDoc", mac),
      { type: "separator" },
      closeWindowItem(t("menu.closeWindow")),
      ...(mac ? [] : [{ role: "quit" as const, label: t("menu.quit") }]),
    ],
  });

  template.push({
    label: t("menu.edit"),
    submenu: [
      actionItem("edit.undo", mac),
      actionItem("edit.redo", mac),
      { type: "separator" },
      actionItem("edit.cut", mac),
      actionItem("edit.copy", mac),
      actionItem("edit.paste", mac),
      actionItem("edit.selectAll", mac),
    ],
  });

  template.push({
    label: t("menu.view"),
    submenu: [
      actionItem("view.zoomIn", mac),
      actionItem("view.zoomOut", mac),
      actionItem("view.zoomReset", mac),
      { type: "separator" },
      actionItem("view.fit", mac),
      actionItem("view.fitAll", mac),
      { type: "separator" },
      actionItem("view.toggleGrid", mac),
      actionItem("view.toggleSnap", mac),
      actionItem("view.toggleGuides", mac),
      { type: "separator" },
      actionItem("view.present", mac),
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
      label: t(commandOf("app.checkUpdates").labelKey),
      click: () => {
        const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        target?.webContents.send(CHANNELS.menuCommand, "app.checkUpdates");
      },
    },
    {
      // 打包版从 Finder 启动时日志只落文件，入口要能被找到
      label: t(commandOf("app.openLogsDir").labelKey),
      click: () => {
        void openLogsDir();
      },
    },
  ];
  if (showDevTools) help.push({ type: "separator" }, devToolsMenuItem(mac));
  help.push(
    { type: "separator" },
    {
      label: t(commandOf("app.about").labelKey),
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
  ipcMain.on(CHANNELS.menuSetState, (_event, next: MenuState) => {
    if (!next || typeof next.docOpen !== "boolean" || typeof next.presenting !== "boolean") {
      // 渲染层传错类型时直接丢弃；必须留一条日志，否则"菜单一直灰着"无从查起
      logApp("warn", "menu: invalid state ignored", {
        docOpen: typeof next?.docOpen,
        presenting: typeof next?.presenting,
      });
      return;
    }
    setMenuState(next);
  });
  ipcMain.handle(CHANNELS.appRunCommand, (_event, id: unknown) => {
    if (!isCommandId(id) || commandOf(id).owner !== "main") return false;
    return runMainCommand(id);
  });
}
