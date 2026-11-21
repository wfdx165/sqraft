/**
 * 命令注册表：菜单、快捷键、⌘K 共用的一份 id 清单。
 *
 * 分工：
 * - `owner: "renderer"` 由 `registerShortcuts()` 登记执行器（画布 / 面板 / 文件入口）；
 * - `owner: "main"` 由主进程处理（设置、MCP 面板、清缓存、日志目录、关于、检查更新）；
 * - 系统 role 项（最小化 / 全屏 / 退出 / 隐藏）不在这里，它们由 Electron 原生菜单执行。
 *
 * `labelKey` 用于面板与快捷键面板；`menuLabelKey` 只在原生菜单里覆盖措辞（"新建" vs "新建文档"）。
 */
import type { MessageKey } from "./i18n";

export type CommandGroup = "file" | "edit" | "view" | "tool" | "component" | "mode" | "other" | "app";

export type CommandOwner = "renderer" | "main";

export type CommandRequirement = "always" | "doc" | "selection";

export interface AppCommand {
  id: CommandId;
  labelKey: MessageKey;
  menuLabelKey?: MessageKey;
  group: CommandGroup;
  owner: CommandOwner;
  /** 默认键位（`⌘⇧Z` 规范串）；没有快捷键就省略 */
  default?: string;
  /** 面板与菜单的可用条件；默认 always */
  requires?: CommandRequirement;
  /** 是否出现在原生菜单 */
  menu?: boolean;
}

export const COMMAND_IDS = [
  "mode.pan",
  "mode.edit",
  "tool.frame",
  "tool.rect",
  "tool.ellipse",
  "tool.triangle",
  "tool.line",
  "tool.path",
  "tool.text",
  "edit.undo",
  "edit.redo",
  "edit.copy",
  "edit.cut",
  "edit.copyImage",
  "edit.selectAll",
  "edit.rename",
  "edit.group",
  "edit.ungroup",
  "edit.delete",
  "edit.duplicate",
  "edit.moveForward",
  "edit.moveBackward",
  "edit.moveToFront",
  "edit.moveToBack",
  "edit.paste",
  "component.create",
  "component.detach",
  "view.zoomIn",
  "view.zoomOut",
  "view.zoomReset",
  "view.fit",
  "view.fitAll",
  "view.toggleGrid",
  "view.toggleSnap",
  "view.toggleGuides",
  "view.present",
  "focus.pageSearch",
  "file.new",
  "file.open",
  "file.insertImage",
  "file.save",
  "file.saveAs",
  "file.exportPng1",
  "file.exportPng2",
  "file.exportPng4",
  "file.exportSvg",
  "file.exportMatrix",
  "file.closeDoc",
  "file.exampleLogin",
  "file.exampleCards",
  "file.exampleUmbra",
  "palette.open",
  "app.settings",
  "app.mcpSetup",
  "app.shortcuts",
  "app.clearImageCache",
  "app.openLogsDir",
  "app.about",
  "app.checkUpdates",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

const COMMAND_ID_SET = new Set<string>(COMMAND_IDS);

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === "string" && COMMAND_ID_SET.has(value);
}

export const COMMANDS: readonly AppCommand[] = [
  // 文件
  { id: "file.new", labelKey: "shortcut.newDoc", menuLabelKey: "menu.new", group: "file", owner: "renderer", default: "⌘N", menu: true },
  { id: "file.open", labelKey: "shortcut.openFile", menuLabelKey: "menu.open", group: "file", owner: "renderer", default: "⌘O", menu: true },
  { id: "file.insertImage", labelKey: "shortcut.insertImage", menuLabelKey: "menu.insertImage", group: "file", owner: "renderer", default: "⇧⌘I", requires: "doc", menu: true },
  { id: "file.save", labelKey: "shortcut.saveFile", menuLabelKey: "menu.save", group: "file", owner: "renderer", default: "⌘S", requires: "doc", menu: true },
  { id: "file.saveAs", labelKey: "shortcut.saveAs", menuLabelKey: "menu.saveAs", group: "file", owner: "renderer", default: "⇧⌘S", requires: "doc", menu: true },
  { id: "file.exportPng1", labelKey: "shortcut.exportPng1", menuLabelKey: "menu.exportPng1", group: "file", owner: "renderer", requires: "doc", menu: true },
  { id: "file.exportPng2", labelKey: "shortcut.exportPng2", menuLabelKey: "menu.exportPng2", group: "file", owner: "renderer", default: "⌘⇧E", requires: "doc", menu: true },
  { id: "file.exportPng4", labelKey: "shortcut.exportPng4", menuLabelKey: "menu.exportPng4", group: "file", owner: "renderer", requires: "doc", menu: true },
  { id: "file.exportSvg", labelKey: "shortcut.exportSvg", menuLabelKey: "menu.exportSvg", group: "file", owner: "renderer", requires: "doc", menu: true },
  { id: "file.exportMatrix", labelKey: "shortcut.exportMatrix", menuLabelKey: "menu.exportMatrix", group: "file", owner: "renderer", requires: "doc", menu: true },
  { id: "file.closeDoc", labelKey: "shortcut.closeDoc", menuLabelKey: "menu.closeDoc", group: "file", owner: "renderer", default: "⌘W", requires: "doc", menu: true },
  { id: "file.exampleLogin", labelKey: "example.login", group: "file", owner: "renderer" },
  { id: "file.exampleCards", labelKey: "example.cards", group: "file", owner: "renderer" },
  { id: "file.exampleUmbra", labelKey: "example.umbra", group: "file", owner: "renderer" },

  // 编辑
  { id: "edit.undo", labelKey: "menu.undo", group: "edit", owner: "renderer", default: "⌘Z", requires: "doc", menu: true },
  { id: "edit.redo", labelKey: "menu.redo", group: "edit", owner: "renderer", default: "⌘⇧Z", requires: "doc", menu: true },
  { id: "edit.cut", labelKey: "menu.cut", group: "edit", owner: "renderer", default: "⌘X", requires: "selection", menu: true },
  { id: "edit.copy", labelKey: "menu.copy", group: "edit", owner: "renderer", default: "⌘C", requires: "selection", menu: true },
  { id: "edit.paste", labelKey: "menu.paste", group: "edit", owner: "renderer", default: "⌘V", requires: "doc", menu: true },
  { id: "edit.selectAll", labelKey: "shortcut.selectAllPage", menuLabelKey: "menu.selectAll", group: "edit", owner: "renderer", default: "⌘A", requires: "doc", menu: true },
  { id: "edit.copyImage", labelKey: "shortcut.copyImage", group: "edit", owner: "renderer", default: "⌘⇧C", requires: "selection" },
  { id: "edit.rename", labelKey: "shortcut.renameLayer", group: "edit", owner: "renderer", default: "F2", requires: "selection" },
  { id: "edit.group", labelKey: "shortcut.group", group: "edit", owner: "renderer", default: "⌘G", requires: "selection" },
  { id: "edit.ungroup", labelKey: "shortcut.ungroup", group: "edit", owner: "renderer", default: "⌘⇧G", requires: "selection" },
  { id: "edit.delete", labelKey: "shortcut.deleteSelection", group: "edit", owner: "renderer", default: "Delete", requires: "selection" },
  { id: "edit.duplicate", labelKey: "shortcut.duplicate", group: "edit", owner: "renderer", default: "⌘D", requires: "selection" },
  { id: "edit.moveForward", labelKey: "shortcut.moveForward", group: "edit", owner: "renderer", default: "⌘]", requires: "selection" },
  { id: "edit.moveBackward", labelKey: "shortcut.moveBackward", group: "edit", owner: "renderer", default: "⌘[", requires: "selection" },
  { id: "edit.moveToFront", labelKey: "shortcut.moveToFront", group: "edit", owner: "renderer", default: "⌘⌥]", requires: "selection" },
  { id: "edit.moveToBack", labelKey: "shortcut.moveToBack", group: "edit", owner: "renderer", default: "⌘⌥[", requires: "selection" },

  // 视图
  { id: "view.zoomIn", labelKey: "menu.zoomIn", group: "view", owner: "renderer", default: "⌘+", requires: "doc", menu: true },
  { id: "view.zoomOut", labelKey: "menu.zoomOut", group: "view", owner: "renderer", default: "⌘−", requires: "doc", menu: true },
  { id: "view.zoomReset", labelKey: "menu.zoomReset", group: "view", owner: "renderer", default: "⌘0", requires: "doc", menu: true },
  { id: "view.fit", labelKey: "menu.fit", group: "view", owner: "renderer", default: "⇧1", requires: "doc", menu: true },
  { id: "view.fitAll", labelKey: "menu.fitAll", group: "view", owner: "renderer", default: "⇧2", requires: "doc", menu: true },
  { id: "view.toggleGrid", labelKey: "menu.showGrid", group: "view", owner: "renderer", default: "⌘'", requires: "doc", menu: true },
  { id: "view.toggleSnap", labelKey: "menu.enableSnap", group: "view", owner: "renderer", default: "⌘⌥'", requires: "doc", menu: true },
  { id: "view.toggleGuides", labelKey: "menu.showGuides", group: "view", owner: "renderer", default: "⌘;", requires: "doc", menu: true },
  { id: "view.present", labelKey: "menu.present", menuLabelKey: "menu.present", group: "view", owner: "renderer", default: "⌥⌘Enter", requires: "doc", menu: true },

  // 工具
  { id: "tool.frame", labelKey: "node.frame", group: "tool", owner: "renderer", default: "F", requires: "doc" },
  { id: "tool.rect", labelKey: "node.rect", group: "tool", owner: "renderer", default: "R", requires: "doc" },
  { id: "tool.ellipse", labelKey: "node.ellipse", group: "tool", owner: "renderer", default: "O", requires: "doc" },
  { id: "tool.triangle", labelKey: "node.triangle", group: "tool", owner: "renderer", default: "G", requires: "doc" },
  { id: "tool.line", labelKey: "node.line", group: "tool", owner: "renderer", default: "L", requires: "doc" },
  { id: "tool.path", labelKey: "toolbar.pen", group: "tool", owner: "renderer", default: "P", requires: "doc" },
  { id: "tool.text", labelKey: "node.text", group: "tool", owner: "renderer", default: "T", requires: "doc" },

  // 组件
  { id: "component.create", labelKey: "shortcut.createComponent", group: "component", owner: "renderer", default: "⌘⌥K", requires: "selection" },
  { id: "component.detach", labelKey: "shortcut.detachInstance", group: "component", owner: "renderer", default: "⌘⌥B", requires: "selection" },

  // 模式
  { id: "mode.pan", labelKey: "shortcut.modePan", group: "mode", owner: "renderer", default: "H", requires: "doc" },
  { id: "mode.edit", labelKey: "shortcut.modeEdit", group: "mode", owner: "renderer", default: "V", requires: "doc" },

  // 其他
  { id: "focus.pageSearch", labelKey: "shortcut.focusPageSearch", group: "other", owner: "renderer", default: "⌘F", requires: "doc" },
  { id: "palette.open", labelKey: "palette.open", group: "other", owner: "renderer", default: "⌘K" },

  // 主进程专属
  { id: "app.settings", labelKey: "menu.settings", group: "app", owner: "main", menu: true },
  { id: "app.mcpSetup", labelKey: "menu.configureMcp", group: "app", owner: "main", menu: true },
  { id: "app.shortcuts", labelKey: "shortcuts.title", group: "app", owner: "main" },
  { id: "app.clearImageCache", labelKey: "menu.clearImageCache", group: "app", owner: "main", menu: true },
  { id: "app.openLogsDir", labelKey: "menu.openLogs", group: "app", owner: "main", menu: true },
  { id: "app.about", labelKey: "menu.about", group: "app", owner: "main", menu: true },
  { id: "app.checkUpdates", labelKey: "menu.checkUpdates", group: "app", owner: "main", menu: true },
];

const BY_ID = new Map<string, AppCommand>(COMMANDS.map((command) => [command.id, command]));

export function commandOf(id: CommandId): AppCommand {
  const command = BY_ID.get(id);
  if (!command) throw new Error(`unknown command: ${id}`);
  return command;
}

/** 面板里的分组顺序；快捷键面板有自己的顺序，不复用这份。 */
export const COMMAND_GROUP_ORDER: readonly CommandGroup[] = [
  "file",
  "edit",
  "view",
  "tool",
  "component",
  "mode",
  "other",
  "app",
];
