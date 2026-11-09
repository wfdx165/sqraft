/**
 * 数值 Token 的读时解析。
 *
 * 节点只存引用（`fontSizeToken` / `cornerRadiusTokens` / `gapToken` …），
 * 渲染、布局、文本测量、检查器读取时统一经过这里；Token 缺失或类型不对时
 * 回退到对应字面量，保证旧文件与被手改的文档不会崩。
 *
 * 只在确有引用时分配新对象——画布热路径上的普通节点不额外产生垃圾。
 */
import { ZERO_CORNER_RADIUS, type DocState, type LayoutSpec, type NodeStyle } from "./model";
import { CORNER_RADIUS_KEYS, PADDING_SIDE_KEYS } from "./token-fields";
import { tokenNumberOf } from "./token-validation";

/** 解析一个数值 Token；缺失/类型不对返回 fallback。 */
export function resolveNumberToken(
  state: DocState,
  path: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (!path) return fallback;
  const entry = state.tokens[path];
  if (!entry || entry.type !== "number") return fallback;
  return tokenNumberOf(entry.value) ?? fallback;
}

/** 解析后的样式：Token 覆盖字面量；没有数值引用时返回原对象。 */
export function resolveNumericStyle(state: DocState, style: NodeStyle): NodeStyle {
  const hasScalar =
    style.fontSizeToken !== undefined ||
    style.lineHeightToken !== undefined ||
    style.letterSpacingToken !== undefined ||
    style.paragraphSpacingToken !== undefined ||
    style.strokeWidthToken !== undefined;
  const hasRadius = style.cornerRadiusTokens !== undefined;
  if (!hasScalar && !hasRadius) return style;

  const next: NodeStyle = { ...style };

  if (style.fontSizeToken !== undefined) {
    const value = resolveNumberToken(state, style.fontSizeToken, style.fontSize);
    // 字号必须为正：Token 值不合法时保留字面量
    if (value !== undefined && value > 0) next.fontSize = value;
  }
  if (style.lineHeightToken !== undefined) {
    const value = resolveNumberToken(state, style.lineHeightToken, style.lineHeight);
    if (value !== undefined && value >= 0) next.lineHeight = value;
  }
  if (style.letterSpacingToken !== undefined) {
    // 字距允许负值（收紧），不做范围夹取
    const value = resolveNumberToken(state, style.letterSpacingToken, style.letterSpacing);
    if (value !== undefined) next.letterSpacing = value;
  }
  if (style.paragraphSpacingToken !== undefined) {
    const value = resolveNumberToken(state, style.paragraphSpacingToken, style.paragraphSpacing);
    if (value !== undefined) next.paragraphSpacing = Math.max(0, value);
  }
  if (style.strokeWidthToken !== undefined) {
    const value = resolveNumberToken(state, style.strokeWidthToken, style.strokeWidth);
    if (value !== undefined) next.strokeWidth = Math.max(0, value);
  }
  if (style.cornerRadiusTokens !== undefined) {
    const radius = { ...(style.cornerRadius ?? ZERO_CORNER_RADIUS) };
    for (const key of CORNER_RADIUS_KEYS) {
      const path = style.cornerRadiusTokens[key];
      if (!path) continue;
      const value = resolveNumberToken(state, path, radius[key]);
      if (value !== undefined) radius[key] = Math.max(0, value);
    }
    next.cornerRadius = radius;
  }

  return next;
}

/** 解析后的布局：Token 覆盖 gap / crossGap / padding；没有引用时返回原对象。 */
export function resolveNumericLayout(state: DocState, layout: LayoutSpec): LayoutSpec {
  if (layout.gapToken === undefined && layout.crossGapToken === undefined && layout.paddingTokens === undefined) {
    return layout;
  }
  const next: LayoutSpec = { ...layout };
  if (layout.gapToken !== undefined) {
    const value = resolveNumberToken(state, layout.gapToken, layout.gap);
    if (value !== undefined) next.gap = Math.max(0, value);
  }
  if (layout.crossGapToken !== undefined) {
    const value = resolveNumberToken(state, layout.crossGapToken, layout.crossGap);
    if (value !== undefined) next.crossGap = Math.max(0, value);
  }
  if (layout.paddingTokens !== undefined) {
    const padding = { ...layout.padding };
    for (const side of PADDING_SIDE_KEYS) {
      const path = layout.paddingTokens[side];
      if (!path) continue;
      const value = resolveNumberToken(state, path, padding[side]);
      if (value !== undefined) padding[side] = Math.max(0, value);
    }
    next.padding = padding;
  }
  return next;
}
