/**
 * 检查器里"这个填充/描边到底是什么渐变"的判定（纯函数）。
 *
 * 抽出来单独测：`.vue` 不在 `tsc` 覆盖内，检查器又必须区分
 * 「字面量渐变」「引用了渐变 Token」「根本不是渐变」三种状态。
 */
import {
  isGradientPaint,
  isGradientValue,
  type GradientValue,
  type NodeStyle,
  type TokenEntry,
} from "@sqraft/core";

export type PaintKind = "fill" | "stroke";

/** 该字段当前引用的渐变 Token 路径；字面量或纯色返回 undefined。 */
export function gradientTokenPathOf(
  style: NodeStyle,
  kind: PaintKind,
  tokens: Record<string, TokenEntry>,
): string | undefined {
  const paint = style[kind];
  if (!paint || isGradientPaint(paint) || !paint.token) return undefined;
  return tokens[paint.token]?.type === "gradient" ? paint.token : undefined;
}

/**
 * 编辑器要展示的渐变：字面量直接用；引用态取 Token 里的值（色标上的颜色 Token 引用原样保留）。
 * Token 缺失或值不合法时返回 undefined——此时检查器不渲染渐变编辑器。
 */
export function gradientValueOf(
  style: NodeStyle,
  kind: PaintKind,
  tokens: Record<string, TokenEntry>,
): GradientValue | undefined {
  const paint = style[kind];
  if (!paint) return undefined;
  if (isGradientPaint(paint)) return paint;
  if (!paint.token) return undefined;
  const entry = tokens[paint.token];
  if (entry?.type !== "gradient" || !isGradientValue(entry.value)) return undefined;
  return entry.value;
}
