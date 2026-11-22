/**
 * 数值 Token 的字段表与引用枚举（单一真源）。
 *
 * core（解析 / 引用改写）、ai-tools（schema 与校验）、渲染层（检查器绑定）、
 * 剪贴板（跨文档复制）都从这里取字段名，避免新增槽位时四处漏改。
 */
import { isShadowEffect } from "./effects";
import { isGradientPaint, type DocNode, type NodeStyle, type Paint } from "./model";

/** NodeStyle 上的单值数值 Token 字段。 */
export const NUMERIC_TOKEN_FIELDS = [
  "fontSizeToken",
  "lineHeightToken",
  "letterSpacingToken",
  "paragraphSpacingToken",
  "strokeWidthToken",
] as const;

export type NumericTokenField = (typeof NUMERIC_TOKEN_FIELDS)[number];

/** 字面量字段 → Token 字段（手改字面量时用于解绑）。 */
export const NUMERIC_TOKEN_OF_LITERAL = {
  fontSize: "fontSizeToken",
  lineHeight: "lineHeightToken",
  letterSpacing: "letterSpacingToken",
  paragraphSpacing: "paragraphSpacingToken",
  strokeWidth: "strokeWidthToken",
} as const satisfies Partial<Record<keyof NodeStyle, NumericTokenField>>;

export type NumericLiteralField = keyof typeof NUMERIC_TOKEN_OF_LITERAL;

/** Token 字段 → 回退字面量字段。 */
export const NUMERIC_LITERAL_OF_TOKEN: Record<NumericTokenField, NumericLiteralField> = {
  fontSizeToken: "fontSize",
  lineHeightToken: "lineHeight",
  letterSpacingToken: "letterSpacing",
  paragraphSpacingToken: "paragraphSpacing",
  strokeWidthToken: "strokeWidth",
};

export const CORNER_RADIUS_KEYS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
export const PADDING_SIDE_KEYS = ["top", "right", "bottom", "left"] as const;

/** 一个 Paint 引用的 Token 路径（渐变取所有 stop）；纯字面量返回空。 */
export function paintTokenPaths(paint: Paint | null | undefined): string[] {
  if (!paint) return [];
  if (!isGradientPaint(paint)) return paint.token ? [paint.token] : [];
  return paint.stops.map((stop) => stop.color?.token).filter((token): token is string => Boolean(token));
}

/** 节点上 Paint 类字段引用的 Token（填充 / 描边 / 阴影颜色，去重）。 */
export function paintTokenPathsOfNode(node: DocNode): string[] {
  const out = new Set<string>();
  for (const path of paintTokenPaths(node.style.fill)) out.add(path);
  for (const path of paintTokenPaths(node.style.stroke)) out.add(path);
  for (const effect of node.style.effects ?? []) {
    if (isShadowEffect(effect)) for (const path of paintTokenPaths(effect.color)) out.add(path);
  }
  return [...out];
}

/** 节点上数值字段引用的 Token（字号 / 圆角 / gap / padding，去重）。 */
export function numericTokenPathsOfNode(node: DocNode): string[] {
  const out = new Set<string>();
  for (const field of NUMERIC_TOKEN_FIELDS) {
    const path = node.style[field];
    if (path) out.add(path);
  }
  const corners = node.style.cornerRadiusTokens;
  if (corners) {
    for (const key of CORNER_RADIUS_KEYS) {
      const path = corners[key];
      if (path) out.add(path);
    }
  }
  if (node.layout) {
    if (node.layout.gapToken) out.add(node.layout.gapToken);
    if (node.layout.crossGapToken) out.add(node.layout.crossGapToken);
    const padding = node.layout.paddingTokens;
    if (padding) {
      for (const key of PADDING_SIDE_KEYS) {
        const path = padding[key];
        if (path) out.add(path);
      }
    }
  }
  return [...out];
}

/** 节点引用的全部 Token 路径（颜色 + 数值，去重）。跨文档复制时用它收集定义。 */
export function tokenPathsOfNode(node: DocNode): string[] {
  return [...new Set([...paintTokenPathsOfNode(node), ...numericTokenPathsOfNode(node)])];
}
