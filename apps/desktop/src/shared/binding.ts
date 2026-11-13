/**
 * 键位的平台显示格式（纯函数，主进程与渲染层共用）。
 *
 * 内部存储永远是 `⌘⇧Z` 这一套：`bindingOfEvent` 把 ctrlKey 归一成 ⌘，用户改键、
 * 冲突检测、菜单加速键都依赖同一种写法。只有显示层需要分平台：
 * Windows / Linux 用户按的是 Ctrl，看到 ⌘ 会不知道怎么按。
 */

const MOD_NAMES: Record<string, string> = { "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift" };

/** Windows 习惯的修饰键顺序：Ctrl → Alt → Shift → 主键 */
const MOD_ORDER = ["Ctrl", "Alt", "Shift"];

/**
 * 规范键位 → 平台显示。
 * macOS 原样返回（`⇧⌘Z`）；其他平台输出 `Ctrl+Shift+Z`。
 * 单键（`H` / `Delete` / `F2`）没有修饰键，原样返回。
 */
export function formatBinding(binding: string, platform: string): string {
  if (!binding || platform === "darwin") return binding;
  const mods = new Set<string>();
  let base = "";
  for (const char of binding) {
    const name = MOD_NAMES[char];
    if (name) mods.add(name);
    else base += char;
  }
  if (mods.size === 0) return binding;
  // "⌘−" 里的 − 是 U+2212；Windows 键帽上印的是 "-"
  if (base === "−") base = "-";
  return [...MOD_ORDER.filter((name) => mods.has(name)), base].join("+");
}
