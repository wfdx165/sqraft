/**
 * 统一的粘贴入口：菜单「粘贴」与 ⌘V 都走这里。
 *
 * 菜单原来用 `role: "paste"`，macOS 会先吃掉 ⌘V，渲染层根本收不到按键
 * （与 `role: "close"` 抢 ⌘W 是同一类问题）。改成显式动作后，键位回到渲染层，
 * 由这里决定"粘文本"还是"粘图片"。
 */
import { hooks, ui } from "./store";

function editableTarget(): HTMLElement | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return null;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el;
  if (el.isContentEditable) return el;
  return null;
}

/**
 * 把文本写进当前输入框（含 contenteditable）。
 *
 * 两个坑：
 * - `type="number"` 等控件没有选区 API（`selectionStart` 为 null），`setRangeText` 会抛
 *   `InvalidStateError`；这类字段没有"光标位置"概念，粘贴就是整值覆盖。
 * - 检查器的字段是 `:value` + `@change`，只派发 `input` 不会落库，必须补一个 `change`。
 */
function insertText(target: HTMLElement, text: string): void {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (start !== null && end !== null) target.setRangeText(text, start, end, "end");
    else target.value = text;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  // contenteditable（画布文本编辑）：execCommand 能保留光标位置与编辑撤销栈
  document.execCommand("insertText", false, text);
}

export async function pasteFromClipboard(): Promise<void> {
  // 1) 焦点在输入框：粘文本，绝不把图片塞进画布
  const target = editableTarget();
  if (target) {
    const text = await window.sqraft.app.readClipboardText();
    if (text) insertText(target, text);
    return;
  }

  // 2) 画布：剪贴板里有图（位图或 Finder 复制的文件）就插入
  if (!ui.docOpen) return;
  const bytes = await window.sqraft.app.readClipboardImage();
  if (!bytes) return;
  await hooks.insertImageBytes(bytes, "粘贴的图片");
}
