/**
 * 快捷键注册表：默认键位 + localStorage 覆盖 + 冲突校验 + 全局分发。
 *
 * 纪律：
 * 1. 键位是**应用级 UI 状态**，不进文档、不进撤销；
 * 2. 面板、tooltip、画布、对话都从 `keyOf()` 读，改键后处处同步（不再硬编码文案）；
 * 3. 单键（无修饰）快捷键在输入框内一律让位；文件/对话类命令仍全局生效。
 */
import { reactive, ref } from "vue";

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
  | "edit.delete"
  | "edit.paste"
  | "component.create"
  | "component.detach"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "view.fit"
  | "view.fitAll"
  | "focus.pageSearch"
  | "file.new"
  | "file.open"
  | "file.insertImage"
  | "file.save"
  | "file.saveAs"
  | "file.closeDoc";

export type ActionGroup = "模式" | "工具" | "编辑" | "组件" | "视图" | "其它";

export interface ShortcutAction {
  id: ActionId;
  group: ActionGroup;
  label: string;
  /** 默认键位的规范写法（见 bindingOfEvent） */
  default: string;
}

export const GROUP_ORDER: ActionGroup[] = ["模式", "工具", "编辑", "组件", "视图", "其它"];

/**
 * `V` 同时是"编辑模式"与"选择工具"：合并成一个动作，避免两条同键记录。
 */
export const ACTIONS: ShortcutAction[] = [
  { id: "mode.pan", group: "模式", label: "拖动模式", default: "H" },
  { id: "mode.edit", group: "模式", label: "编辑模式 / 选择", default: "V" },
  { id: "tool.frame", group: "工具", label: "画板", default: "F" },
  { id: "tool.rect", group: "工具", label: "矩形", default: "R" },
  { id: "tool.ellipse", group: "工具", label: "椭圆", default: "O" },
  { id: "tool.triangle", group: "工具", label: "三角形", default: "G" },
  { id: "tool.line", group: "工具", label: "直线", default: "L" },
  { id: "tool.path", group: "工具", label: "钢笔", default: "P" },
  { id: "tool.text", group: "工具", label: "文本", default: "T" },
  { id: "edit.undo", group: "编辑", label: "撤销", default: "⌘Z" },
  { id: "edit.redo", group: "编辑", label: "重做", default: "⌘⇧Z" },
  { id: "edit.delete", group: "编辑", label: "删除选中", default: "Delete" },
  { id: "edit.paste", group: "编辑", label: "粘贴", default: "⌘V" },
  { id: "component.create", group: "组件", label: "创建组件", default: "⌘⌥K" },
  { id: "component.detach", group: "组件", label: "脱离实例", default: "⌘⌥B" },
  { id: "view.zoomIn", group: "视图", label: "放大", default: "⌘+" },
  { id: "view.zoomOut", group: "视图", label: "缩小", default: "⌘−" },
  { id: "view.zoomReset", group: "视图", label: "缩放回到 100%", default: "⌘0" },
  { id: "view.fit", group: "视图", label: "适配页面", default: "⇧1" },
  { id: "view.fitAll", group: "视图", label: "查看全部页面", default: "⇧2" },
  { id: "focus.pageSearch", group: "其它", label: "聚焦页面搜索", default: "⌘F" },
  { id: "file.new", group: "其它", label: "新建文档", default: "⌘N" },
  { id: "file.open", group: "其它", label: "打开文件", default: "⌘O" },
  { id: "file.insertImage", group: "其它", label: "插入图片", default: "⇧⌘I" },
  { id: "file.save", group: "其它", label: "保存文件", default: "⌘S" },
  { id: "file.saveAs", group: "其它", label: "另存为", default: "⇧⌘S" },
  { id: "file.closeDoc", group: "其它", label: "关闭文档", default: "⌘W" },
];

/** 固定键位：不可修改，面板底部作为只读参考展示。 */
export const PANEL_BINDING = "⌘/";
export const FIXED_HINTS: { keys: string; label: string }[] = [
  { keys: "Esc", label: "取消 / 逐级退出" },
  { keys: PANEL_BINDING, label: "快捷键设置" },
  { keys: "⌘Enter", label: "提交文案" },
];

/** 系统菜单/角色占用，绑了也轮不到我们。 */
const RESERVED = new Set(["⌘R", "⌘T", "⌘Q", "⌘M", "⌘H", "⌘⌥Esc", "⌘⇧W", "⌘⇧T"]);

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
  if (!binding) return "请按下一个组合键";
  if (binding === PANEL_BINDING) return `${PANEL_BINDING} 固定用于打开快捷键面板`;
  if (binding === "Esc") return "Esc 固定用于取消";
  if (RESERVED.has(binding)) return `${binding} 被系统菜单占用，不能绑定`;
  const taken = ACTIONS.find((a) => a.id !== id && keyOf(a.id) === binding);
  if (taken) return `已被「${taken.label}」使用`;
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

/** 供组件主动触发某动作（如面板里"试试"按钮），未登记则忽略。 */
export function runAction(id: ActionId): void {
  executors.get(id)?.();
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    // Esc 由画布做分层退出，这里不抢
    if (e.key === "Escape") return;

    const binding = bindingOfEvent(e);
    if (!binding) return;

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
    if (!run) return;
    if (!GLOBAL_ACTIONS.has(action.id) && isTypingTarget(e.target)) return;
    e.preventDefault();
    run();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
