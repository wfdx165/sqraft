/** 工具参数 → 命令参数的解析与校验（与 schema 分离：schema 只给客户端看，校验在这里真的执行）。 */

import type { CornerRadius, DocNode, DocState, DocStore, Effect, LayoutSpec, NodeId, NodeStyle, Padding, VectorAnchor } from "@sqraft/core";
import { CORNER_RADIUS_KEYS, DEFAULT_PAGE_HEIGHT, DEFAULT_PAGE_WIDTH, NUMERIC_TOKEN_FIELDS, NUMERIC_TOKEN_OF_LITERAL, PADDING_SIDE_KEYS, createLayoutSpec, createNode, firstPageId, makeAnchor, nextPageName, walkSubtree } from "@sqraft/core";

export function readPoints(value: unknown): VectorAnchor[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error("points 必须是锚点数组");
  return value.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new Error(`points[${i}] 必须是对象`);
    const p = raw as Record<string, unknown>;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`points[${i}] 的 x/y 必须是数值`);
    const offset = (key: string): number => {
      const v = p[key];
      if (v === undefined) return 0;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`points[${i}].${key} 必须是数值`);
      return n;
    };
    return makeAnchor(x, y, { inX: offset("inX"), inY: offset("inY"), outX: offset("outX"), outY: offset("outY") });
  });
}

export function applyStyleTokens(style: NodeStyle, args: Record<string, unknown>): void {
  // Token 优先；没有 Token 时才用字面量（设计系统由用户自己定，不强制）
  if (args.fillToken !== undefined) style.fill = { token: String(args.fillToken) };
  else if (typeof args.fill === "string") style.fill = { value: args.fill };
  if (args.strokeToken !== undefined) style.stroke = { token: String(args.strokeToken) };
  else if (typeof args.stroke === "string") style.stroke = { value: args.stroke };
  if (args.strokeWidth !== undefined) style.strokeWidth = Math.max(0, Number(args.strokeWidth));
}

export function assertToken(store: DocStore, token: string | undefined, field: string): void {
  if (token === undefined) return;
  if (!store.doc.tokens[token]) {
    throw new Error(
      `${field} 引用了不存在的 Token "${token}"；先调用 define_token 建这个 Token，或改用 fill / stroke 传字面量色值。`,
    );
  }
}

/** 数值 Token：必须存在且 type=number（颜色 Token 不能塞进 fontSizeToken 之类的字段）。 */
export function assertNumberToken(store: DocStore, token: string | null | undefined, field: string): void {
  if (token === undefined || token === null || token === "") return;
  const entry = store.doc.tokens[token];
  if (!entry) {
    throw new Error(
      `${field} 引用了不存在的 Token "${token}"；先调用 define_token 建这个 Token，或改用字面量数值。`,
    );
  }
  if (entry.type !== "number") {
    throw new Error(`${field} 需要数值 Token，但 "${token}" 是颜色 Token；改用数值 Token 或字面量数值。`);
  }
}

/** 逐项合并 Token 映射：null / 空串解绑，其余写入；没有剩余键时返回 undefined。 */
export function mergeTokenMap<T extends Record<string, string>>(base: T | undefined, patch: unknown): T | undefined {
  if (!patch || typeof patch !== "object") return base;
  const map: Record<string, string> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null || value === "") delete map[key];
    else if (typeof value === "string") map[key] = value;
  }
  return Object.keys(map).length > 0 ? (map as T) : undefined;
}

/** 校验一次调用里所有数值 Token 入参（存在 + 类型正确）。 */
export function assertNumericTokenArgs(store: DocStore, args: Record<string, unknown>): void {
  for (const key of NUMERIC_TOKEN_FIELDS) {
    if (args[key] === undefined || args[key] === null) continue;
    assertNumberToken(store, String(args[key]), key);
  }
  const corners = args.cornerRadiusTokens;
  if (corners && typeof corners === "object") {
    for (const key of CORNER_RADIUS_KEYS) {
      const value = (corners as Record<string, unknown>)[key];
      if (value === undefined || value === null) continue;
      assertNumberToken(store, String(value), `cornerRadiusTokens.${key}`);
    }
  }
  const layout = args.layout;
  if (layout && typeof layout === "object") {
    const raw = layout as Record<string, unknown>;
    for (const key of ["gapToken", "crossGapToken"] as const) {
      if (raw[key] === undefined || raw[key] === null) continue;
      assertNumberToken(store, String(raw[key]), `layout.${key}`);
    }
    const padding = raw.paddingTokens;
    if (padding && typeof padding === "object") {
      for (const key of PADDING_SIDE_KEYS) {
        const value = (padding as Record<string, unknown>)[key];
        if (value === undefined || value === null) continue;
        assertNumberToken(store, String(value), `layout.paddingTokens.${key}`);
      }
    }
  }
}

export function findSlotByName(store: DocStore, instanceId: NodeId, name: string): NodeId | null {
  let found: NodeId | null = null;
  walkSubtree(store.doc, instanceId, (n) => {
    if (!found && n.type === "slot" && n.name === name) found = n.id;
  });
  return found;
}

export function cornerFrom(value: unknown): CornerRadius | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    return { topLeft: value, topRight: value, bottomRight: value, bottomLeft: value };
  }
  const c = value as Partial<CornerRadius>;
  return {
    topLeft: Number(c.topLeft ?? 0),
    topRight: Number(c.topRight ?? 0),
    bottomRight: Number(c.bottomRight ?? 0),
    bottomLeft: Number(c.bottomLeft ?? 0),
  };
}

export function paddingFrom(value: unknown): Padding {
  if (typeof value === "number") return { top: value, right: value, bottom: value, left: value };
  const p = (value ?? {}) as Partial<Padding>;
  return { top: Number(p.top ?? 0), right: Number(p.right ?? 0), bottom: Number(p.bottom ?? 0), left: Number(p.left ?? 0) };
}

/** 布局入参 → 显式字段的 patch（未传的字段保持原值，供 update 合并）。 */
export function layoutPatchFrom(value: unknown): Partial<LayoutSpec> | undefined {
  if (value === undefined) return undefined;
  const raw = value as Record<string, unknown>;
  const patch: Partial<LayoutSpec> = {};
  if (raw.direction !== undefined) patch.direction = raw.direction as LayoutSpec["direction"];
  if (raw.gap !== undefined) patch.gap = Number(raw.gap);
  if (raw.padding !== undefined) patch.padding = paddingFrom(raw.padding);
  if (raw.gapToken !== undefined) patch.gapToken = raw.gapToken === null ? undefined : String(raw.gapToken);
  if (raw.crossGapToken !== undefined) {
    patch.crossGapToken = raw.crossGapToken === null ? undefined : String(raw.crossGapToken);
  }
  if (raw.paddingTokens !== undefined) {
    patch.paddingTokens = raw.paddingTokens as LayoutSpec["paddingTokens"];
  }
  if (raw.mainAlign !== undefined) patch.mainAlign = raw.mainAlign as LayoutSpec["mainAlign"];
  if (raw.crossAlign !== undefined) patch.crossAlign = raw.crossAlign as LayoutSpec["crossAlign"];
  if (raw.wrap !== undefined) patch.wrap = Boolean(raw.wrap);
  if (raw.crossGap !== undefined) patch.crossGap = Number(raw.crossGap);
  if (raw.alignContent !== undefined) patch.alignContent = raw.alignContent as LayoutSpec["alignContent"];
  // 只传字面量 = 解绑对应的 Token（与检查器手改一致）
  if (raw.gap !== undefined && raw.gapToken === undefined) patch.gapToken = undefined;
  if (raw.crossGap !== undefined && raw.crossGapToken === undefined) patch.crossGapToken = undefined;
  if (raw.padding !== undefined && raw.paddingTokens === undefined) patch.paddingTokens = undefined;
  return patch;
}

/** 外观与排版字段（只在显式传入时覆盖）。 */
export function applyStyleArgs(style: NodeStyle, args: Record<string, unknown>): NodeStyle {
  const next: NodeStyle = { ...style };
  const keys = [
    "fontFamily", "fontWeight", "fontStyle", "fontSize", "lineHeight", "lineHeightUnit",
    "letterSpacing", "letterSpacingUnit", "paragraphSpacing", "textAlign", "textVerticalAlign",
    "textCase", "textDecoration",
  ] as const;
  for (const key of keys) {
    if (args[key] !== undefined) (next as Record<string, unknown>)[key] = args[key];
  }
  const corner = cornerFrom(args.cornerRadius);
  if (corner) next.cornerRadius = corner;
  for (const key of NUMERIC_TOKEN_FIELDS) {
    if (args[key] === undefined) continue;
    (next as Record<string, unknown>)[key] = args[key] === null ? undefined : String(args[key]);
  }
  if (args.cornerRadiusTokens !== undefined) {
    next.cornerRadiusTokens = mergeTokenMap(next.cornerRadiusTokens, args.cornerRadiusTokens);
  }
  // 自动行高会忽略数值：绑定行高 Token 时切到 px，否则绑定看似无效
  if (args.lineHeightToken && (next.lineHeightUnit ?? "auto") === "auto") next.lineHeightUnit = "px";
  // 只传字面量 = 解绑对应的 Token（与检查器手改一致）
  for (const [literal, token] of Object.entries(NUMERIC_TOKEN_OF_LITERAL)) {
    if (args[literal] !== undefined && args[token] === undefined) delete next[token as keyof NodeStyle];
  }
  if (args.cornerRadius !== undefined && args.cornerRadiusTokens === undefined) next.cornerRadiusTokens = undefined;
  applyStyleTokens(next, args);
  if (args.effects !== undefined) next.effects = effectsFrom(args.effects);
  return next;
}

/** 效果入参 → 模型效果：颜色可以引用 Token，也可以给字面量。 */
export function effectsFrom(value: unknown): Effect[] {
  if (!Array.isArray(value)) throw new Error("effects 必须是数组");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("effects 的每一项必须是对象");
    const item = raw as Record<string, unknown>;
    const type = String(item.type);
    if (type === "drop-shadow" || type === "inner-shadow") {
      const token = typeof item.fillToken === "string" ? item.fillToken : "";
      const literal = typeof item.color === "string" ? item.color : "";
      if (!token && !literal) {
        throw new Error("阴影类效果需要 fillToken 或 color（字面量色值）之一。");
      }
      return {
        type,
        visible: item.visible === undefined ? true : Boolean(item.visible),
        x: Number(item.x ?? 0),
        y: Number(item.y ?? 0),
        blur: Math.max(0, Number(item.blur ?? 0)),
        spread: Number(item.spread ?? 0),
        color: token ? { token } : { value: literal },
      } as Effect;
    }
    if (type === "layer-blur" || type === "backdrop-blur") {
      return {
        type,
        visible: item.visible === undefined ? true : Boolean(item.visible),
        radius: Math.max(0, Number(item.radius ?? 0)),
      } as Effect;
    }
    throw new Error(`未知的效果类型 "${type}"；只支持 drop-shadow / inner-shadow / layer-blur / backdrop-blur。`);
  });
}

/** 效果里的阴影颜色同样必须是已存在的 Token。 */
export function assertEffectTokens(store: DocStore, effects: Effect[] | undefined): void {
  for (const effect of effects ?? []) {
    if (effect.type === "drop-shadow" || effect.type === "inner-shadow") {
      assertToken(store, effect.color.token, "effects.fillToken");
    }
  }
}

/** 节点几何/布局字段（只在显式传入时覆盖）。`baseLayout` 有值时布局按字段合并。 */
export function applyNodeArgs(args: Record<string, unknown>, baseLayout?: LayoutSpec): Partial<DocNode> {
  const patch: Partial<DocNode> = {};
  const keys = [
    "x", "y", "width", "height", "rotation", "opacity", "visible", "locked", "clip",
    "layoutSizingW", "layoutSizingH", "layoutMinW", "layoutMinH", "layoutMaxW", "layoutMaxH",
    "layoutAbsolute", "text", "textAutoResize", "listType", "truncate",
    "scrollDirection",
  ] as const;
  for (const key of keys) {
    if (args[key] !== undefined) (patch as Record<string, unknown>)[key] = args[key];
  }
  const layout = layoutPatchFrom(args.layout);
  if (layout) {
    if (layout.paddingTokens !== undefined) {
      layout.paddingTokens = mergeTokenMap(baseLayout?.paddingTokens, layout.paddingTokens);
    }
    patch.layout = baseLayout ? { ...baseLayout, ...layout } : createLayoutSpec(layout);
  }
  return patch;
}

/** 会改动文档的工具：一次调用包成一个事务，撤销时只算一步。 */

export function assertImageUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`图片地址不是合法的 URL：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("图片地址只支持 http/https");
  }
}

/** 报错里最多列几个节点，其余用数量收口 */
export const TOKEN_REF_PREVIEW = 5;
/** 节点名截断长度：名字是用户随手起的，可能很长 */
export const REF_NAME_MAX = 24;

/** 被引用时拒绝删除：给 agent 明确的下一步（detach 会冻结成什么值），并带节点名便于核对 */
export function blockedDeleteMessage(doc: DocState, path: string, refs: NodeId[], value: string): string {
  const preview = refs
    .slice(0, TOKEN_REF_PREVIEW)
    .map((id) => `${(doc.nodes[id]?.name ?? "未命名").slice(0, REF_NAME_MAX)}(${id})`)
    .join("、");
  const rest = refs.length > TOKEN_REF_PREVIEW ? `，另有 ${refs.length - TOKEN_REF_PREVIEW} 个` : "";
  return (
    `Token "${path}" 仍被 ${refs.length} 个节点引用：${preview}${rest}` +
    `；传 detach=true 会把它们冻结为 ${value} 后删除（完整名单见 read_document）`
  );
}

/** 空文档没有页面：先建第一页（与人工"新建页面"同一套命令，仍在这一条事务里）。 */
export function ensurePage(store: DocStore, pagePrefix = "页面"): NodeId {
  const existing = firstPageId(store.doc);
  if (existing) return existing;
  const page = createNode("page", {
    name: nextPageName(store.doc, pagePrefix),
    x: 0,
    y: 0,
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT,
  });
  store.apply({ type: "node.create", params: { nodes: [page], parentId: null } }, "ai:page");
  return page.id;
}
