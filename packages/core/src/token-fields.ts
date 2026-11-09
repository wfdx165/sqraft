/**
 * 数值 Token 的字段表与引用枚举（单一真源）。
 *
 * core（解析 / 引用改写）、ai-tools（schema 与校验）、渲染层（检查器绑定）、
 * 剪贴板（跨文档复制）都从这里取字段名，避免新增槽位时四处漏改。
 */
import { isShadowEffect } from "./effects";
import type { DocNode, NodeStyle } from "./model";

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

/** 节点引用的全部 Token 路径（颜色 + 数值，去重）。跨文档复制时用它收集定义。 */
export function tokenPathsOfNode(node: DocNode): string[] {
  const out = new Set<string>();
  const add = (path: string | undefined) => {
    if (path) out.add(path);
  };

  add(node.style.fill?.token);
  add(node.style.stroke?.token);
  for (const effect of node.style.effects ?? []) {
    if (isShadowEffect(effect)) add(effect.color.token);
  }
  for (const field of NUMERIC_TOKEN_FIELDS) add(node.style[field]);
  const corners = node.style.cornerRadiusTokens;
  if (corners) for (const key of CORNER_RADIUS_KEYS) add(corners[key]);
  if (node.layout) {
    add(node.layout.gapToken);
    add(node.layout.crossGapToken);
    const padding = node.layout.paddingTokens;
    if (padding) for (const key of PADDING_SIDE_KEYS) add(padding[key]);
  }

  return [...out];
}
