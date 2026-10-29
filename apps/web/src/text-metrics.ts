/**
 * 文本尺寸测量：画布渲染与 DOM 行内编辑共用同一套字体参数，
 * 保证"框贴合文字"在编辑前后一致（行高倍数来自 core 的 TEXT_LINE_HEIGHT）。
 */
import { TEXT_LINE_HEIGHT } from "@sqraft/core";

export const DEFAULT_TEXT_FONT_SIZE = 20;
export const DEFAULT_TEXT_FONT_FAMILY = "'Geist Variable', 'PingFang SC', sans-serif";

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === "undefined") return null;
  measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

export function textFont(fontSize: number, fontFamily = DEFAULT_TEXT_FONT_FAMILY, fontWeight = 400): string {
  return `${fontWeight} ${fontSize}px ${fontFamily}`;
}

/** 文本在给定字号下的包围盒（宽 = 最长行，高 = 行数 × 行高）。 */
export function measureTextSize(
  text: string,
  fontSize = DEFAULT_TEXT_FONT_SIZE,
  fontFamily = DEFAULT_TEXT_FONT_FAMILY,
  fontWeight = 400,
): { width: number; height: number } {
  const lines = (text.length ? text : " ").split("\n");
  const ctx = getMeasureCtx();
  let width = 0;
  if (ctx) {
    ctx.font = textFont(fontSize, fontFamily, fontWeight);
    for (const line of lines) width = Math.max(width, ctx.measureText(line || " ").width);
  } else {
    // 无 DOM（如单测环境）时用近似值兜底
    width = Math.max(...lines.map((l) => l.length)) * fontSize * 0.6;
  }
  return {
    width: Math.max(1, Math.ceil(width)),
    height: Math.ceil(lines.length * fontSize * TEXT_LINE_HEIGHT),
  };
}
