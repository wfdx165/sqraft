/**
 * 文本行内编辑：DOM 浮层的状态与提交逻辑（屏幕坐标）。
 * 编辑期间不写文档；提交时一次性 node.update，撤销一步。
 */
import { nextTick, ref } from "vue";
import { TEXT_LINE_HEIGHT, worldRect, type DocNode, type NodeId } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { dispatch, docStore, select, ui } from "../store";
import { DEFAULT_TEXT_FONT_FAMILY, DEFAULT_TEXT_FONT_SIZE, measureTextSize } from "../text-metrics";

export interface TextEditState {
  id: NodeId;
  value: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  /** 打开时的缩放比例（编辑期间缩放会先提交并关闭） */
  scale: number;
}

export function useTextEditing(vp: Viewport, markDirty: () => void) {
  const textEdit = ref<TextEditState | null>(null);
  const textEditEl = ref<HTMLTextAreaElement | null>(null);

  function syncTextEditSize(): void {
    const ed = textEdit.value;
    if (!ed) return;
    const size = measureTextSize(ed.value, ed.fontSize, ed.fontFamily, ed.fontWeight);
    ed.width = Math.max(size.width * ed.scale + 6, 24);
    ed.height = Math.max(size.height * ed.scale, ed.fontSize * ed.scale * TEXT_LINE_HEIGHT);
  }

  function startTextEdit(node: DocNode, selectAll = false): void {
    const r = worldRect(docStore.doc, node.id);
    if (!r) return;
    const a = worldToScreen(vp, r.x, r.y);
    const fontSize = node.style.fontSize ?? DEFAULT_TEXT_FONT_SIZE;
    const fontFamily = node.style.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY;
    const fontWeight = node.style.fontWeight ?? 400;
    const scale = vp.zoom;
    const size = measureTextSize(node.text ?? "文本", fontSize, fontFamily, fontWeight);
    // DOM 行盒有半行距，向上补偿使输入文字与画布文字位置一致
    const halfLeading = ((TEXT_LINE_HEIGHT - 1) * fontSize * scale) / 2;
    textEdit.value = {
      id: node.id,
      value: node.text ?? "",
      left: a.x,
      top: a.y - halfLeading,
      width: Math.max(size.width * scale + 6, 24),
      height: Math.max(size.height * scale, fontSize * scale * TEXT_LINE_HEIGHT),
      fontSize,
      fontFamily,
      fontWeight,
      scale,
    };
    select([node.id]);
    markDirty();
    void nextTick(() => {
      const el = textEditEl.value;
      if (!el) return;
      el.focus();
      if (selectAll) el.select();
      else el.setSelectionRange(el.value.length, el.value.length);
      syncTextEditSize();
    });
  }

  function commitTextEdit(): void {
    const ed = textEdit.value;
    textEdit.value = null;
    if (!ed) return;
    const node = docStore.doc.nodes[ed.id];
    if (!node) {
      markDirty();
      return;
    }
    const text = ed.value.replace(/\r\n/g, "\n");
    if (!text.trim()) {
      dispatch({ type: "node.delete", params: { nodeId: ed.id } }, "edit-text");
      select(ui.selection.filter((id) => id !== ed.id));
      markDirty();
      return;
    }
    if (text === (node.text ?? "")) {
      markDirty();
      return;
    }
    const size = measureTextSize(text, ed.fontSize, ed.fontFamily, ed.fontWeight);
    dispatch(
      { type: "node.update", params: { nodeId: ed.id, patch: { text, width: size.width, height: size.height } } },
      "edit-text",
    );
    markDirty();
  }

  function cancelTextEdit(): void {
    textEdit.value = null;
    markDirty();
  }

  function onTextEditKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitTextEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelTextEdit();
    }
  }

  return { textEdit, textEditEl, syncTextEditSize, startTextEdit, commitTextEdit, cancelTextEdit, onTextEditKey };
}
