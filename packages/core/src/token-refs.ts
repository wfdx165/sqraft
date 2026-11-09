/**
 * Token 引用的查询与改写（纯函数，不依赖 DOM）。
 *
 * 引用可能出现在三处：填充、描边、以及效果里的颜色（投影 / 内阴影）。
 * 改名与"删除时冻结引用"共用同一套遍历，避免两边各写一遍后慢慢漂移。
 */
import { isShadowEffect } from "./effects";
import {
  CORNER_RADIUS_KEYS,
  NUMERIC_LITERAL_OF_TOKEN,
  NUMERIC_TOKEN_FIELDS,
  PADDING_SIDE_KEYS,
} from "./token-fields";
import { tokenNumberOf } from "./token-validation";
import type { DocNode, DocState, LayoutSpec, NodeId, NodeStyle, Paint } from "./model";
import type { Command } from "./store";

/** 这个 style 是否引用了数值 Token `path`。 */
export function hasNumericTokenRef(style: NodeStyle, path: string): boolean {
  for (const tokenKey of NUMERIC_TOKEN_FIELDS) {
    if (style[tokenKey] === path) return true;
  }
  const corners = style.cornerRadiusTokens;
  return Boolean(corners && CORNER_RADIUS_KEYS.some((key) => corners[key] === path));
}

/** 这个 layout 是否引用了数值 Token `path`。 */
export function hasNumericLayoutTokenRef(layout: LayoutSpec, path: string): boolean {
  if (layout.gapToken === path || layout.crossGapToken === path) return true;
  const padding = layout.paddingTokens;
  return Boolean(padding && PADDING_SIDE_KEYS.some((key) => padding[key] === path));
}

/** 节点（style 或 layout）是否引用了数值 Token `path`。 */
export function hasNodeNumericTokenRef(node: DocNode, path: string): boolean {
  return hasNumericTokenRef(node.style, path) || Boolean(node.layout && hasNumericLayoutTokenRef(node.layout, path));
}

/** 这个 style 是否引用了 `path`。 */
export function hasTokenRef(style: NodeStyle, path: string): boolean {
  if (style.fill?.token === path || style.stroke?.token === path) return true;
  return Boolean(style.effects?.some((effect) => isShadowEffect(effect) && effect.color.token === path));
}

/** 引用了 `path` 的节点（按文档遍历顺序，颜色与数值引用都算）。 */
export function tokenRefsOf(state: DocState, path: string): NodeId[] {
  const ids: NodeId[] = [];
  for (const node of Object.values(state.nodes)) {
    if (hasTokenRef(node.style, path) || hasNodeNumericTokenRef(node, path)) ids.push(node.id);
  }
  return ids;
}

/**
 * 把 style 里指向 `path` 的 Paint 按 `map` 改写；没有命中返回 null。
 * 返回的是**整体替换**后的 style（不变式 5：`patch.style` 不走合并）。
 */
export function mapTokenPaints(
  style: NodeStyle,
  path: string,
  map: (paint: Paint) => Paint,
): NodeStyle | null {
  let next: NodeStyle | null = null;

  if (style.fill?.token === path) next = { ...style, fill: map(style.fill) };
  if (style.stroke?.token === path) next = { ...(next ?? style), stroke: map(style.stroke) };

  const effects = style.effects;
  if (effects?.some((effect) => isShadowEffect(effect) && effect.color.token === path)) {
    const base = next ?? style;
    next = {
      ...base,
      effects: (base.effects ?? []).map((effect) => {
        if (!isShadowEffect(effect) || effect.color.token !== path) return effect;
        return { ...effect, color: map(effect.color) };
      }),
    };
  }

  return next;
}

/**
 * 把 style / layout 里指向 `from` 的数值引用改成 `to`；没有命中返回 null。
 * `layout` 允许为空（纯样式节点）。
 */
export function mapNumericTokenRefs(
  style: NodeStyle,
  layout: LayoutSpec | undefined,
  from: string,
  to: string,
): { style?: NodeStyle; layout?: LayoutSpec } | null {
  let nextStyle: NodeStyle | null = null;
  for (const tokenKey of NUMERIC_TOKEN_FIELDS) {
    if (style[tokenKey] !== from) continue;
    nextStyle = { ...(nextStyle ?? style), [tokenKey]: to } as NodeStyle;
  }
  const corners = style.cornerRadiusTokens;
  if (corners && CORNER_RADIUS_KEYS.some((key) => corners[key] === from)) {
    const map: NonNullable<NodeStyle["cornerRadiusTokens"]> = { ...corners };
    for (const key of CORNER_RADIUS_KEYS) {
      if (map[key] === from) map[key] = to;
    }
    nextStyle = { ...(nextStyle ?? style), cornerRadiusTokens: map };
  }

  let nextLayout: LayoutSpec | null = null;
  if (layout) {
    if (layout.gapToken === from) nextLayout = { ...(nextLayout ?? layout), gapToken: to };
    if (layout.crossGapToken === from) nextLayout = { ...(nextLayout ?? layout), crossGapToken: to };
    const padding = layout.paddingTokens;
    if (padding && PADDING_SIDE_KEYS.some((key) => padding[key] === from)) {
      const map: NonNullable<LayoutSpec["paddingTokens"]> = { ...padding };
      for (const key of PADDING_SIDE_KEYS) {
        if (map[key] === from) map[key] = to;
      }
      nextLayout = { ...(nextLayout ?? layout), paddingTokens: map };
    }
  }

  if (!nextStyle && !nextLayout) return null;
  return {
    ...(nextStyle ? { style: nextStyle } : {}),
    ...(nextLayout ? { layout: nextLayout } : {}),
  };
}

/** 改写实例覆盖表里的数值引用（style 与 layout 各一份持久化差异）。 */
export function mapOverrideNumericRefs(node: DocNode, from: string, to: string): boolean {
  const overrides = node.overrides;
  if (!overrides) return false;
  let touched = false;
  const next: NonNullable<DocNode["overrides"]> = { ...overrides };
  for (const [key, override] of Object.entries(overrides)) {
    const mapped = mapNumericTokenRefs(override.style ?? {}, override.layout, from, to);
    if (!mapped) continue;
    next[key] = {
      ...override,
      ...(mapped.style ? { style: mapped.style } : {}),
      ...(mapped.layout ? { layout: mapped.layout } : {}),
    };
    touched = true;
  }
  if (touched) node.overrides = next;
  return touched;
}

/** 数值冻结时的范围约定：字号必须为正，字距允许负值，其余非负。 */
function clampNumericLiteral(field: keyof NodeStyle, value: number, fallback: number | undefined): number | undefined {
  if (field === "fontSize") return value > 0 ? value : fallback;
  if (field === "letterSpacing") return value;
  return Math.max(0, value);
}

/** 把这个 style 里指向 `path` 的数值引用冻结成字面量；没有命中返回 null。 */
function freezeNumericStyle(style: NodeStyle, path: string, value: number | null): NodeStyle | null {
  let next: NodeStyle | null = null;
  for (const tokenKey of NUMERIC_TOKEN_FIELDS) {
    if (style[tokenKey] !== path) continue;
    const literalKey = NUMERIC_LITERAL_OF_TOKEN[tokenKey];
    next = { ...(next ?? style) };
    if (value !== null) {
      const frozen = clampNumericLiteral(literalKey, value, style[literalKey]);
      if (frozen !== undefined) (next as Record<string, unknown>)[literalKey] = frozen;
    }
    delete next[tokenKey];
  }
  const corners = style.cornerRadiusTokens;
  if (corners && CORNER_RADIUS_KEYS.some((key) => corners[key] === path)) {
    const map: NonNullable<NodeStyle["cornerRadiusTokens"]> = { ...corners };
    const radius = {
      ...(next?.cornerRadius ?? style.cornerRadius ?? { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 }),
    };
    for (const key of CORNER_RADIUS_KEYS) {
      if (map[key] !== path) continue;
      delete map[key];
      if (value !== null) radius[key] = Math.max(0, value);
    }
    next = { ...(next ?? style), cornerRadius: radius };
    if (Object.keys(map).length > 0) next.cornerRadiusTokens = map;
    else delete next.cornerRadiusTokens;
  }
  return next;
}

/** 把这个 layout 里指向 `path` 的数值引用冻结成字面量；没有命中返回 null。 */
function freezeNumericLayout(layout: LayoutSpec, path: string, value: number | null): LayoutSpec | null {
  let next: LayoutSpec | null = null;
  if (layout.gapToken === path) {
    next = { ...(next ?? layout), gap: value === null ? layout.gap : Math.max(0, value) };
    delete next.gapToken;
  }
  if (layout.crossGapToken === path) {
    next = { ...(next ?? layout), crossGap: value === null ? layout.crossGap : Math.max(0, value) };
    delete next.crossGapToken;
  }
  const padding = layout.paddingTokens;
  if (padding && PADDING_SIDE_KEYS.some((key) => padding[key] === path)) {
    const map: NonNullable<LayoutSpec["paddingTokens"]> = { ...padding };
    const box = { ...(next?.padding ?? layout.padding) };
    for (const key of PADDING_SIDE_KEYS) {
      if (map[key] !== path) continue;
      delete map[key];
      if (value !== null) box[key] = Math.max(0, value);
    }
    next = { ...(next ?? layout), padding: box };
    if (Object.keys(map).length > 0) next.paddingTokens = map;
    else delete next.paddingTokens;
  }
  return next;
}

/**
 * 改写节点**覆盖表**里指向 `from` 的 Paint。
 *
 * 实例的字段差异另存一份（`instance.overrides[key].style`），同步时由 `diffNode` 叠加到
 * 母版值上；只改 `node.style` 而漏掉它，下一次组件同步就会把旧路径写回克隆节点。
 * 返回是否有改动；没有命中时不重建对象。
 *
 * 只处理一层：`NodeOverride` 类型上允许 `overrides[key].overrides`（嵌套实例的覆盖表），
 * 但 `computeSelfOverride` / `computeOuterOverride` 都不写这个字段，这里不做递归。
 */
export function mapOverridePaints(
  node: DocNode,
  from: string,
  map: (paint: Paint) => Paint,
): boolean {
  const overrides = node.overrides;
  if (!overrides) return false;

  let touched = false;
  const next: NonNullable<DocNode["overrides"]> = { ...overrides };
  for (const [key, override] of Object.entries(overrides)) {
    if (!override.style) continue;
    const style = mapTokenPaints(override.style, from, map);
    if (!style) continue;
    next[key] = { ...override, style };
    touched = true;
  }
  if (touched) node.overrides = next;
  return touched;
}

/**
 * 删除前把引用冻结成字面量所需的命令（仅 `planTokenDelete` 内部使用）。
 *
 * 冻结值取 Token 当前取值，视觉零变化；这些命令与 `token.delete` 必须在同一个事务里，
 * 否则撤销只能恢复 Token，恢复不了被改写的 style。
 *
 * **只改节点自己的 style**：实例覆盖表由 `recordOverrides` 在 `node.update` 应用后按克隆节点
 * 的新 style 重算，不需要这里直接改。也正因如此，不要单独给 `tokenRefsOf` 加上"扫覆盖表"——
 * 两处必须同时改，否则会出现"一直 blocked 但 detach 也删不掉"的半截状态。
 *
 * 注意：锁定节点的 `node.update` 会被 `DocStore` 拒绝（与手工改样式一致），
 * 调用方应把错误原样报给用户，不要吞掉。
 */
function detachTokenRefs(state: DocState, path: string): Command[] {
  const entry = state.tokens[path];
  if (!entry) return [];
  const value = String(entry.value);
  const numberValue = entry.type === "number" ? tokenNumberOf(entry.value) : null;

  const commands: Command[] = [];
  for (const node of Object.values(state.nodes)) {
    let style = mapTokenPaints(node.style, path, () => ({ value })) ?? node.style;
    const frozen = freezeNumericStyle(style, path, numberValue);
    if (frozen) style = frozen;
    const layout = node.layout ? freezeNumericLayout(node.layout, path, numberValue) : null;
    if (style === node.style && !layout) continue;
    commands.push({
      type: "node.update",
      params: {
        nodeId: node.id,
        patch: {
          ...(style !== node.style ? { style } : {}),
          ...(layout ? { layout } : {}),
        },
      },
    });
  }
  return commands;
}

/**
 * 删除 Token 的完整计划。
 *
 * 有引用且未要求 detach 时只给 `blocked`（调用方据此报错或弹确认）；
 * 否则给出「冻结引用 + 删除」的命令序列——调用方负责把这一串放进**同一条事务**，
 * 否则撤销只回得来 Token，回不来被改写的 style。
 */
export type TokenDeletePlan =
  | { status: "missing" }
  | { status: "blocked"; refs: NodeId[]; value: string }
  | { status: "ready"; refs: NodeId[]; value: string; commands: Command[] };

export function planTokenDelete(state: DocState, path: string, detach: boolean): TokenDeletePlan {
  const entry = state.tokens[path];
  if (!entry) return { status: "missing" };

  const refs = tokenRefsOf(state, path);
  const value = String(entry.value);
  if (refs.length > 0 && !detach) return { status: "blocked", refs, value };

  return {
    status: "ready",
    refs,
    value,
    commands: [...detachTokenRefs(state, path), { type: "token.delete", params: { path } }],
  };
}
