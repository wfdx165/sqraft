/**
 * 文本行内编辑：contenteditable 浮层（屏幕坐标）。
 * 与画布共用同一套字体、行高、字距、对齐、装饰与列表样式；
 * 编辑期间不写文档，提交时一次 node.update，撤销一步。
 */
import { nextTick, ref } from "vue";
import {
  fontString,
  fontSizeOf,
  letterSpacingPx,
  lineHeightPx,
  resolveNumericStyle,
  worldRect,
  type DocNode,
  type ListType,
  type NodeId,
} from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { dispatch, docStore, select, ui } from "../store";
import { textSizeOf } from "../text-metrics";

export interface TextEditState {
  id: NodeId;
  value: string;
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
  css: Record<string, string>;
  listType: ListType;
  html: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function editorHtml(text: string): string {
  const lines = text.length ? text.split("\n") : [""];
  return lines.map((line) => `<div>${line ? escapeHtml(line) : "<br>"}</div>`).join("");
}

function readEditorHtml(el: HTMLElement): string {
  const text = el.innerText.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return text;
}

function cssFor(node: DocNode, scale: number): Record<string, string> {
  const style = resolveNumericStyle(docStore.doc, node.style);
  const lineHeight = lineHeightPx(style) * scale;
  const spacing = letterSpacingPx(style) * scale;
  const decoration =
    style.textDecoration === "underline"
      ? "underline"
      : style.textDecoration === "strikethrough"
        ? "line-through"
        : "none";
  const transform =
    style.textCase === "upper"
      ? "uppercase"
      : style.textCase === "lower"
        ? "lowercase"
        : style.textCase === "title"
          ? "capitalize"
          : "none";
  return {
    "--para": `${(style.paragraphSpacing ?? 0) * scale}px`,
    font: fontString({ ...style, fontSize: fontSizeOf(style) * scale }),
    lineHeight: `${lineHeight}px`,
    letterSpacing: `${spacing}px`,
    textAlign: style.textAlign === "justify" ? "justify" : (style.textAlign ?? "left"),
    textDecoration: decoration,
    textTransform: transform,
    color: "#000000",
  };
}

export function useTextEditing(vp: Viewport, markDirty: () => void) {
  const textEdit = ref<TextEditState | null>(null);
  const textEditEl = ref<HTMLDivElement | null>(null);

  function updatePreview(): void {
    const ed = textEdit.value;
    if (!ed) return;
    const node = docStore.doc.nodes[ed.id];
    if (!node) return;
    const style = resolveNumericStyle(docStore.doc, node.style);
    const size = textSizeOf(node, style, ed.value, docStore.doc);
    const fixed = (node.textAutoResize ?? "auto-width") === "fixed";
    ed.width = Math.max(24, (fixed ? node.width : size.width) * ed.scale + 4);
    ed.height = Math.max(lineHeightPx(style) * ed.scale, (fixed ? node.height : size.height) * ed.scale);
  }

  function startTextEdit(node: DocNode, selectAll = false): void {
    const r = worldRect(docStore.doc, node.id);
    if (!r) return;
    const a = worldToScreen(vp, r.x, r.y);
    const scale = vp.zoom;
    const style = resolveNumericStyle(docStore.doc, node.style);
    const size = textSizeOf(node, style, node.text ?? "文本", docStore.doc);
    const fixed = (node.textAutoResize ?? "auto-width") === "fixed";
    const css = cssFor(node, scale);
    const alignY = node.style.textVerticalAlign ?? "top";
    if (fixed && alignY !== "top") {
      const pad = Math.max(0, node.height - size.height);
      css.paddingTop = `${(alignY === "middle" ? pad / 2 : pad) * scale}px`;
    }
    textEdit.value = {
      id: node.id,
      value: node.text ?? "",
      left: a.x,
      top: a.y,
      width: Math.max(24, (fixed ? node.width : size.width) * scale + 4),
      height: Math.max(lineHeightPx(style) * scale, (fixed ? node.height : size.height) * scale),
      scale,
      css,
      listType: node.listType ?? "none",
      html: editorHtml(node.text ?? ""),
    };
    select([node.id]);
    markDirty();
    void nextTick(() => {
      const el = textEditEl.value;
      if (!el) return;
      el.focus();
      if (selectAll) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } else {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      updatePreview();
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
    const patch: Partial<DocNode> = { text };
    const mode = node.textAutoResize ?? "auto-width";
    if (mode !== "fixed") {
      const size = textSizeOf(node, node.style, text, docStore.doc);
      if (mode === "auto-width") patch.width = size.width;
      patch.height = size.height;
    }
    dispatch({ type: "node.update", params: { nodeId: ed.id, patch } }, "edit-text");
    markDirty();
  }

  function cancelTextEdit(): void {
    textEdit.value = null;
    markDirty();
  }

  function onTextEditInput(e: Event): void {
    const el = e.target as HTMLElement;
    const ed = textEdit.value;
    if (!ed) return;
    ed.value = readEditorHtml(el);
    updatePreview();
  }

  function onTextEditKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cancelTextEdit();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commitTextEdit();
    }
  }

  return { textEdit, textEditEl, startTextEdit, commitTextEdit, cancelTextEdit, onTextEditInput, onTextEditKey };
}
