/**
 * 快捷键注册表：默认键位 + localStorage 覆盖 + 冲突校验 + 全局分发。
 *
 * 纪律：
 * 1. 键位是**应用级 UI 状态**，不进文档、不进撤销；
 * 2. 面板、tooltip、画布都从 `keyOf()` 读，改键后处处同步（不再硬编码文案）；
 * 3. 单键（无修饰）快捷键在输入框内一律让位；文件类命令仍全局生效。
 */
import { reactive, ref } from "vue";
import { logInfo, logWarn } from "./log";
import { t } from "./i18n";
import { ui } from "./store";
import { formatBinding as sharedFormatBinding } from "../shared/binding";
import type { MessageKey } from "../shared/i18n";

export type ActionId =
  | "mode.pan"
  | "mode.edit"
  | "tool.frame"
  | "tool.rect"
  | "tool.ellipse"
  | "tool.triangle"
  | "tool.line"
  | "tool.path"
  | "tool.text"
  | "edit.undo"
  | "edit.redo"
  | "edit.copy"
  | "edit.cut"
  | "edit.copyImage"
  | "edit.selectAll"
  | "edit.rename"
  | "edit.group"
  | "edit.ungroup"
  | "edit.delete"
  | "edit.duplicate"
  | "edit.moveForward"
  | "edit.moveBackward"
  | "edit.moveToFront"
  | "edit.moveToBack"
  | "edit.paste"
  | "component.create"
  | "component.detach"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "view.fit"
  | "view.fitAll"
  | "view.toggleGrid"
  | "view.toggleSnap"
  | "view.toggleGuides"
  | "view.present"
  | "focus.pageSearch"
  | "file.new"
  | "file.open"
  | "file.insertImage"
  | "file.save"
  | "file.saveAs"
  | "file.exportPng"
  | "file.closeDoc";

export type ActionGroup = "mode" | "tool" | "edit" | "component" | "view" | "other";

export interface ShortcutAction {
  id: ActionId;
  group: ActionGroup;
  labelKey: MessageKey;
  /** 默认键位的规范写法（见 bindingOfEvent） */
  default: string;
}

export const GROUP_ORDER: ActionGroup[] = ["mode", "tool", "edit", "component", "view", "other"];

/**
 * `V` 同时是"编辑模式"与"选择工具"：合并成一个动作，避免两条同键记录。
 */
export const ACTIONS: ShortcutAction[] = [
  { id: "mode.pan", group: "mode", labelKey: "shortcut.modePan", default: "H" },
  { id: "mode.edit", group: "mode", labelKey: "shortcut.modeEdit", default: "V" },
  { id: "tool.frame", group: "tool", labelKey: "node.frame", default: "F" },
  { id: "tool.rect", group: "tool", labelKey: "node.rect", default: "R" },
  { id: "tool.ellipse", group: "tool", labelKey: "node.ellipse", default: "O" },
  { id: "tool.triangle", group: "tool", labelKey: "node.triangle", default: "G" },
  { id: "tool.line", group: "tool", labelKey: "node.line", default: "L" },
  { id: "tool.path", group: "tool", labelKey: "toolbar.pen", default: "P" },
  { id: "tool.text", group: "tool", labelKey: "node.text", default: "T" },
  { id: "edit.copy", group: "edit", labelKey: "menu.copy", default: "⌘C" },
  { id: "edit.copyImage", group: "edit", labelKey: "shortcut.copyImage", default: "⌘⇧C" },
  { id: "edit.selectAll", group: "edit", labelKey: "shortcut.selectAllPage", default: "⌘A" },
  { id: "edit.rename", group: "edit", labelKey: "shortcut.renameLayer", default: "F2" },
  { id: "edit.group", group: "edit", labelKey: "shortcut.group", default: "⌘G" },
  { id: "edit.ungroup", group: "edit", labelKey: "shortcut.ungroup", default: "⌘⇧G" },
  { id: "edit.cut", group: "edit", labelKey: "menu.cut", default: "⌘X" },
  { id: "edit.undo", group: "edit", labelKey: "menu.undo", default: "⌘Z" },
  { id: "edit.redo", group: "edit", labelKey: "menu.redo", default: "⌘⇧Z" },
  { id: "edit.delete", group: "edit", labelKey: "shortcut.deleteSelection", default: "Delete" },
  { id: "edit.duplicate", group: "edit", labelKey: "shortcut.duplicate", default: "⌘D" },
  { id: "edit.moveForward", group: "edit", labelKey: "shortcut.moveForward", default: "⌘]" },
  { id: "edit.moveBackward", group: "edit", labelKey: "shortcut.moveBackward", default: "⌘[" },
  { id: "edit.moveToFront", group: "edit", labelKey: "shortcut.moveToFront", default: "⌘⌥]" },
  { id: "edit.moveToBack", group: "edit", labelKey: "shortcut.moveToBack", default: "⌘⌥[" },
  { id: "edit.paste", group: "edit", labelKey: "menu.paste", default: "⌘V" },
  { id: "component.create", group: "component", labelKey: "shortcut.createComponent", default: "⌘⌥K" },
  { id: "component.detach", group: "component", labelKey: "shortcut.detachInstance", default: "⌘⌥B" },
  { id: "view.zoomIn", group: "view", labelKey: "menu.zoomIn", default: "⌘+" },
  { id: "view.zoomOut", group: "view", labelKey: "menu.zoomOut", default: "⌘−" },
  { id: "view.zoomReset", group: "view", labelKey: "shortcut.zoomReset", default: "⌘0" },
  { id: "view.fit", group: "view", labelKey: "menu.fit", default: "⇧1" },
  { id: "view.fitAll", group: "view", labelKey: "menu.fitAll", default: "⇧2" },
  { id: "view.toggleGrid", group: "view", labelKey: "menu.showGrid", default: "⌘'" },
  { id: "view.toggleSnap", group: "view", labelKey: "menu.enableSnap", default: "⌘⌥'" },
  { id: "view.toggleGuides", group: "view", labelKey: "menu.showGuides", default: "⌘;" },
  { id: "view.present", group: "view", labelKey: "menu.present", default: "⌥⌘Enter" },
  { id: "focus.pageSearch", group: "other", labelKey: "shortcut.focusPageSearch", default: "⌘F" },
  { id: "file.new", group: "other", labelKey: "shortcut.newDoc", default: "⌘N" },
  { id: "file.open", group: "other", labelKey: "shortcut.openFile", default: "⌘O" },
  { id: "file.insertImage", group: "other", labelKey: "shortcut.insertImage", default: "⇧⌘I" },
  { id: "file.save", group: "other", labelKey: "shortcut.saveFile", default: "⌘S" },
  { id: "file.saveAs", group: "other", labelKey: "shortcut.saveAs", default: "⇧⌘S" },
  { id: "file.exportPng", group: "other", labelKey: "shortcut.exportPng", default: "⌘⇧E" },
  { id: "file.closeDoc", group: "other", labelKey: "shortcut.closeDoc", default: "⌘W" },
];

/** 固定键位：不可修改，面板底部作为只读参考展示。 */
export const PANEL_BINDING = "⌘/";
export const FIXED_HINTS: { keys: string; labelKey: MessageKey }[] = [
  { keys: "Esc", labelKey: "shortcut.fixedCancel" },
  { keys: PANEL_BINDING, labelKey: "shortcut.fixedPanel" },
  { keys: "⌘Enter", labelKey: "shortcut.fixedCommit" },
];

/** 系统菜单/角色占用，绑了也轮不到我们。 */
const RESERVED = new Set(["⌘R", "⌘T", "⌘Q", "⌘M", "⌘H", "⌘⌥Esc", "⌘⇧W", "⌘⇧T", "⌘⌥I", "F12"]);

/** 输入焦点内仍然生效的命令（保存/打开/页面搜索不该被输入框吞掉）。 */
const GLOBAL_ACTIONS = new Set<ActionId>([
  "file.new",
  "file.open",
  "file.insertImage",
  "edit.paste",
  "file.save",
  "file.saveAs",
  "file.closeDoc",
  "focus.pageSearch",
]);

const STORAGE_KEY = "sqraft.shortcuts.v1";

/** 键位版本号：菜单靠它感知"用户改了键位"，从而刷新菜单里的提示。 */
export const bindingRev = ref(0);

/** 面板与录制状态（纯 UI）。 */
export const shortcutUi = reactive({
  open: false,
  recording: null as ActionId | null,
  error: "",
});

function loadOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const known = new Set(ACTIONS.map((a) => a.id));
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (known.has(id as ActionId) && typeof value === "string" && value) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** 只存与默认不同的项；空对象直接删掉这个 key。 */
const overrides = reactive<Record<string, string>>(loadOverrides());

function persist(): void {
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可 */
  }
}

const DEFAULTS = new Map(ACTIONS.map((a) => [a.id, a.default]));

export function defaultKeyOf(id: ActionId): string {
  return DEFAULTS.get(id) ?? "";
}

/** 当前生效键位（响应式：模板/computed 中读取会随改键刷新）。 */
export function keyOf(id: ActionId): string {
  return overrides[id] ?? defaultKeyOf(id);
}

export function isDefault(id: ActionId): boolean {
  return !overrides[id];
}

const PLATFORM_FALLBACK = "darwin";

/** 平台只在浏览器里有；node 环境（单测）退回 macOS，不能让默认参数直接炸。 */
function platformOf(): string {
  if (typeof window === "undefined") return PLATFORM_FALLBACK;
  return window.sqraft?.platform ?? PLATFORM_FALLBACK;
}

/**
 * 规范键位 → 平台显示。
 *
 * 内部存储永远是 `⌘⇧Z` 这一套（`bindingOfEvent` 把 ctrlKey 归一成 ⌘），
 * 只有显示在 Windows 上换成 `Ctrl+Shift+Z`：用户按的是 Ctrl，看到 ⌘ 会不知道怎么按。
 * 单键（H / Delete / F2）原样返回。
 */
export function formatBinding(binding: string, platform: string = platformOf()): string {
  return sharedFormatBinding(binding, platform);
}

/** 面板 / tooltip / 右键菜单里的键位文案（已按平台格式化）。 */
export function keyLabel(id: ActionId): string {
  return formatBinding(keyOf(id));
}

export function setBinding(id: ActionId, binding: string): void {
  if (binding === defaultKeyOf(id)) delete overrides[id];
  else overrides[id] = binding;
  persist();
  bindingRev.value += 1;
}

export function resetAll(): void {
  for (const key of Object.keys(overrides)) delete overrides[key];
  persist();
  bindingRev.value += 1;
}

/** 返回错误文案；空串表示可以绑定。 */
export function validateBinding(id: ActionId, binding: string): string {
  if (!binding) return t("shortcut.needCombo");
  if (binding === PANEL_BINDING) return t("shortcut.panelFixed", { keys: formatBinding(PANEL_BINDING) });
  if (binding === "Esc") return t("shortcut.escFixed");
  if (RESERVED.has(binding)) return t("shortcut.reserved", { keys: formatBinding(binding) });
  const taken = ACTIONS.find((a) => a.id !== id && keyOf(a.id) === binding);
  if (taken) return t("shortcut.taken", { label: t(taken.labelKey) });
  return "";
}

/* ---------- 事件 → 规范键位 ---------- */

/** Shift 打出来的符号：这类键不再额外记 ⇧（`⌘+` 而不是 `⌘⇧=`）。 */
const SHIFTED_SYMBOLS = new Set(["~", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "{", "}", "|", ":", '"', "<", ">", "?"]);

const CODE_MAP: Record<string, string> = {
  Slash: "/",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Space: "Space",
  Backspace: "Delete",
  Delete: "Delete",
  Escape: "Esc",
  Enter: "Enter",
  NumpadEnter: "Enter",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Tab: "Tab",
};

function baseKeyOf(e: KeyboardEvent): string | null {
  const code = e.code || "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  if (/^F\d{1,2}$/.test(code)) return code;
  if (code === "Minus") return e.shiftKey ? "_" : "−";
  if (code === "Equal") return e.shiftKey ? "+" : "=";
  if (CODE_MAP[code]) return CODE_MAP[code];
  const key = e.key;
  if (!key || key === "Dead" || key === "Unidentified") return null;
  if (key === "Meta" || key === "Control" || key === "Alt" || key === "Shift") return null;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** 键盘事件 → `⌘⇧Z` 这类规范键位；只按修饰键时返回 null（继续等）。 */
export function bindingOfEvent(e: KeyboardEvent): string | null {
  const base = baseKeyOf(e);
  if (!base) return null;
  const mods: string[] = [];
  if (e.metaKey || e.ctrlKey) mods.push("⌘");
  if (e.altKey) mods.push("⌥");
  if (e.shiftKey && !SHIFTED_SYMBOLS.has(base)) mods.push("⇧");
  return mods.join("") + base;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(el.isContentEditable);
}

/* ---------- 执行器注册与全局分发 ---------- */

const executors = new Map<ActionId, () => void>();

/** 组件挂载时登记自己能执行的命令；返回注销函数。 */
export function registerShortcuts(map: Partial<Record<ActionId, () => void>>): () => void {
  const ids = Object.keys(map) as ActionId[];
  for (const id of ids) executors.set(id, map[id]!);
  return () => {
    for (const id of ids) {
      if (executors.get(id) === map[id]) executors.delete(id);
    }
  };
}

/** 供组件主动触发某动作（菜单派发、面板里的"试试"按钮），未登记则忽略但留痕。 */
export function runAction(id: ActionId): void {
  // 演示模式只读：原生菜单也能触发动作，这里必须和键盘走同一道闸门
  if (ui.presenter && id !== "view.present") {
    logWarn("menu action dropped while presenting", { action: id });
    return;
  }
  const run = executors.get(id);
  if (!run) {
    // 菜单项在欢迎页等没有执行器的状态下点击：和快捷键同一条兜底
    logWarn("menu action dropped: no executor", { action: id });
    return;
  }
  logInfo("menu action", { action: id });
  run();
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    // 按住键会连发：注册表分发只认首次按下。重复触发曾让"保存"被第二次调用撞上
    // 对话框/互斥（见 .scratch/logging/issues/02-save-race-fixes.md）
    if (e.repeat) return;
    // Esc 由画布做分层退出，这里不抢
    if (e.key === "Escape") return;

    const binding = bindingOfEvent(e);
    if (!binding) return;
    // 演示模式：除"演示"入口本身（用于退出）外全部让位
    if (ui.presenter && binding !== keyOf("view.present")) return;

    // ⌘/ 是固定入口：面板开着时也要能关（先于"面板打开即让位"判断）
    if (binding === PANEL_BINDING) {
      e.preventDefault();
      shortcutUi.open = !shortcutUi.open;
      shortcutUi.recording = null;
      shortcutUi.error = "";
      return;
    }

    // 面板打开时其余快捷键让位（面板自己处理录制）
    if (shortcutUi.open) return;

    const action = ACTIONS.find((a) => keyOf(a.id) === binding);
    if (!action) return;
    const run = executors.get(action.id);
    if (!run) {
      // 快捷键按对了但没人接：这是"点了没反应"的一类现场，必须留痕
      logWarn("shortcut dropped: no executor", { action: action.id, binding, repeat: e.repeat });
      return;
    }
    if (!GLOBAL_ACTIONS.has(action.id) && isTypingTarget(e.target)) return;
    e.preventDefault();
    logInfo("action", { action: action.id, binding, repeat: e.repeat });
    run();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
