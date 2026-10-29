/**
 * 文本测量：把 Canvas 的字体宽度注入 core 的行盒算法。
 * 画布渲染、检查器测量与 DOM 行内编辑共用同一份结果。
 */
import {
  DEFAULT_TEXT_FONT_FAMILY,
  DEFAULT_TEXT_FONT_SIZE,
  layoutText,
  measureTextBox,
  type DocNode,
  type MeasureText,
  type NodeStyle,
} from "@sqraft/core";

export { DEFAULT_TEXT_FONT_FAMILY, DEFAULT_TEXT_FONT_SIZE };

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === "undefined") return null;
  measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

/** Canvas 宽度测量；无 DOM 时按字号估算。 */
export const measureText: MeasureText = (text: string, font: string): number => {
  const ctx = getMeasureCtx();
  if (!ctx) {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? DEFAULT_TEXT_FONT_SIZE);
    return [...text].length * size * 0.58;
  }
  ctx.font = font;
  return ctx.measureText(text).width;
};

/** 文本节点的目标尺寸（按 textAutoResize）。 */
export function textSizeOf(
  node: Pick<DocNode, "width" | "height" | "textAutoResize" | "listType" | "truncate">,
  style: NodeStyle,
  text: string,
): { width: number; height: number } {
  return measureTextBox(node, style, measureText, text);
}

/** 行盒结果，供行内编辑预览与渲染调试使用。 */
export function textLayoutOf(
  node: Pick<DocNode, "width" | "height" | "textAutoResize" | "listType" | "truncate">,
  style: NodeStyle,
  text: string,
) {
  const mode = node.textAutoResize ?? "auto-width";
  return layoutText(text, style, {
    measure: measureText,
    listType: node.listType,
    maxWidth: mode === "auto-width" ? undefined : node.width,
    maxHeight: mode === "fixed" ? node.height : undefined,
    truncate: node.truncate,
  });
}
