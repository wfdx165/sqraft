import { computed, ref, watch } from "vue";
import {
  ZERO_CORNER_RADIUS,
  ZERO_PADDING,
  createEffect,
  createLayoutSpec,
  EFFECT_LABELS,
  sanitizeEffect,
  findOuterOverrideOwner,
  findOverrideOwner,
  newId,
  resolvePaint,
  resolveNumericLayout,
  resolveNumericStyle,
  NUMERIC_TOKEN_OF_LITERAL,
  type Command,
  type ComponentPropertyDef,
  type CornerRadius,
  type DocNode,
  type Effect,
  type EffectType,
  type LayoutSpec,
  type ListType,
  type NodeStyle,
  type Padding,
  type ShadowEffect,
  type TextAutoResize,
  type AlignEdge,
  type DistributeAxis,
  scaleFactorsTo,
  type Rect,
} from "@sqraft/core";
import { textSizeOf } from "../text-metrics";
import { dispatch, docStore, hooks, ui } from "../store";
import { putAsset } from "../assets";
import { firstFamilyOf, fontFamilies, fontWeightsOf, putFont } from "../fonts";
import { selectionBounds as boundsOf } from "../canvas/selection-bounds";
import { createTokenBindings } from "./token-bindings";

/**
 * 检查器的状态与动作：模板只负责排版，逻辑集中在这里。
 * 放到独立文件是为了控制单文件体积（见 PR review P1-7）。
 */
export function useInspector() {
const MIXED = Symbol("mixed");
type Mixed = typeof MIXED;

/* ---------- 选区 ---------- */

const nodes = computed<DocNode[]>(() => {
  void ui.version;
  return ui.selection.map((id) => docStore.doc.nodes[id]).filter((n): n is DocNode => Boolean(n));
});

const node = computed<DocNode | null>(() => nodes.value[0] ?? null);
const multi = computed(() => nodes.value.length > 1);
const allText = computed(() => nodes.value.length > 0 && nodes.value.every((n) => n.type === "text"));
const hasType = (...types: string[]) => nodes.value.length > 0 && nodes.value.every((n) => types.includes(n.type));
// 页面也接受填充：那是"页面背景色"（缺省白）
const supportsFill = computed(() =>
  hasType("page", "frame", "rect", "ellipse", "polygon", "path", "text", "component", "instance", "slot"),
);
const supportsStroke = computed(() =>
  hasType("frame", "rect", "ellipse", "polygon", "path", "line", "text", "component", "instance", "slot"),
);
const supportsRadius = computed(() => hasType("frame", "rect", "component", "instance", "slot"));
const supportsClip = computed(() => hasType("frame", "component", "instance"));
const supportsLayout = computed(() => hasType("frame", "component"));
const supportsSizing = computed(() =>
  nodes.value.length > 0 &&
  nodes.value.every((n) => {
    const parent = n.parentId ? docStore.doc.nodes[n.parentId] : null;
    return Boolean(parent?.layout) && !n.layoutAbsolute && n.type !== "page";
  }),
);

function lockedChain(n: DocNode | null | undefined): boolean {
  let cur = n;
  while (cur) {
    if (cur.locked) return true;
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : null;
  }
  return false;
}

const readonly = computed(() => nodes.value.some((n) => lockedChain(n)));

/* ---------- 数值 Token 绑定 ---------- */

/** 文本字面量 → Token 字段（手改字面量时解绑，字段表与 core 共用一份）。 */
const TEXT_TOKEN_FIELDS = (["fontSize", "lineHeight", "letterSpacing", "paragraphSpacing"] as const).map(
  (literal) => [literal, NUMERIC_TOKEN_OF_LITERAL[literal]] as const,
);

const tokenBindings = createTokenBindings({ nodes, node, applyStyle, applyTextStyle, applyNodes });

/** 批量编辑目标：跳过页面与锁定子树。 */
function targets(): DocNode[] {
  return nodes.value.filter((n) => n.type !== "page" && !lockedChain(n));
}

function applyNodes(fn: (n: DocNode) => Partial<DocNode> | null, label = "inspect"): void {
  const cmds: Command[] = [];
  for (const n of targets()) {
    const patch = fn(n);
    if (patch && Object.keys(patch).length > 0) {
      cmds.push({ type: "node.update", params: { nodeId: n.id, patch } });
    }
  }
  if (cmds.length > 0) dispatch(cmds, label);
}

/**
 * 样式写入：页面也参与（页面的 `style.fill` 就是背景色），
 * 但几何/布局等入口仍走 `targets()`，对页面禁用。
 */
function applyStyle(fn: (style: NodeStyle, n: DocNode) => NodeStyle, label = "inspect"): void {
  const cmds: Command[] = [];
  for (const n of nodes.value) {
    if (lockedChain(n)) continue;
    const style = fn({ ...n.style }, n);
    cmds.push({ type: "node.update", params: { nodeId: n.id, patch: { style } } });
  }
  if (cmds.length > 0) dispatch(cmds, label);
}

/* ---------- 字体导入 ---------- */

const fontInput = ref<HTMLInputElement | null>(null);

/** 已导入的字族（下拉里单独一组） */
const importedFamilies = computed(() => {
  void ui.version;
  return fontFamilies();
});

/** 当前字族实际有的字重；系统字体给全档 */
const weightOptions = computed<number[]>(() => {
  const family = firstFamilyOf(String(nodes.value[0]?.style.fontFamily ?? ""));
  const imported = importedFamilies.value.find((name) => name.toLowerCase() === family.toLowerCase());
  return imported ? fontWeightsOf(imported) : [100, 200, 300, 400, 500, 600, 700, 800, 900];
});

async function importFont(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const result = await putFont(new Uint8Array(await file.arrayBuffer()), file.name);
  if (!result.ok) {
    await window.sqraft.dialog.error(result.reason);
    return;
  }
  // 导入即套用到当前文本选区，省一次手动选择
  const stack = `'${result.record.family}', sans-serif`;
  applyStyle((style) => ({ ...style, fontFamily: stack, fontWeight: result.record.weight }));
  ui.version += 1;
}

/* ---------- 页面背景图 ---------- */

const backgroundInput = ref<HTMLInputElement | null>(null);

async function setBackgroundImage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const page = nodes.value.find((n) => n.type === "page");
  if (!file || !page) return;
  const asset = await putAsset(new Uint8Array(await file.arrayBuffer()));
  if (!asset.ok) {
    await window.sqraft.dialog.error(asset.reason);
    return;
  }
  dispatch(
    {
      type: "node.update",
      params: {
        nodeId: page.id,
        patch: {
          backgroundImage: {
            assetId: asset.id,
            fit: page.backgroundImage?.fit ?? "cover",
          },
        },
      },
    },
    "背景图",
  );
}

function setBackgroundFit(event: Event): void {
  const page = nodes.value.find((n) => n.type === "page");
  if (!page?.backgroundImage) return;
  const fit = (event.target as HTMLSelectElement).value as "cover" | "contain" | "tile";
  dispatch(
    { type: "node.update", params: { nodeId: page.id, patch: { backgroundImage: { ...page.backgroundImage, fit } } } },
    "背景图",
  );
}

function clearBackgroundImage(): void {
  const page = nodes.value.find((n) => n.type === "page");
  if (!page) return;
  dispatch(
    { type: "node.update", params: { nodeId: page.id, patch: { backgroundImage: undefined } } },
    "清除背景图",
  );
}

/* ---------- 多选包围盒 ---------- */

/** 多选的选区包围盒（世界坐标）：X/Y 平移整体，W/H 等比缩放整体 */
const selectionBounds = computed<Rect | null>(() => {
  void ui.version;
  return boundsOf(docStore.doc, nodes.value.map((n) => n.id));
});

function setBoundsNumber(key: "x" | "y" | "w" | "h", event: Event): void {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  const box = selectionBounds.value;
  if (!Number.isFinite(value) || !box) return;
  const ids = targets().map((n) => n.id);
  if (ids.length === 0) return;
  if (key === "x" || key === "y") {
    const dx = key === "x" ? value - box.x : 0;
    const dy = key === "y" ? value - box.y : 0;
    dispatch(
      ids.map((id) => {
        const node = docStore.doc.nodes[id];
        return { type: "node.update" as const, params: { nodeId: id, patch: { x: node.x + dx, y: node.y + dy } } };
      }),
      "移动",
    );
    return;
  }
  const factors = scaleFactorsTo(
    docStore.doc,
    ids,
    key === "w" ? Math.max(1, value) : box.width,
    key === "h" ? Math.max(1, value) : box.height,
  );
  if (!factors) return;
  dispatch({ type: "node.scale", params: { nodeIds: ids, ...factors } }, "缩放");
}

/* ---------- 对齐与分布 ---------- */

/** 自动布局子项的位置由布局求解器决定，手改坐标会被立刻覆盖 */
const layoutBound = computed(() =>
  nodes.value.some((n) => {
    const parent = n.parentId ? docStore.doc.nodes[n.parentId] : null;
    return Boolean(parent?.layout) && !n.layoutAbsolute;
  }),
);
// 页面没有父级可对齐：整组不显示
const showAlign = computed(() => nodes.value.length > 0 && !nodes.value.some((n) => n.type === "page"));
// 锁定节点不参与排列：整组置灰，解锁后再排（避免"只动一部分"的意外结果）
const canAlign = computed(() => showAlign.value && !layoutBound.value && !readonly.value);
const canDistribute = computed(
  () => nodes.value.length >= 3 && !layoutBound.value && !readonly.value,
);

function align(edge: AlignEdge): void {
  if (!canAlign.value) return;
  dispatch(
    { type: "node.align", params: { nodeIds: targets().map((n) => n.id), align: edge } },
    "对齐",
  );
}

function distribute(axis: DistributeAxis): void {
  if (!canDistribute.value) return;
  dispatch(
    { type: "node.distribute", params: { nodeIds: targets().map((n) => n.id), axis } },
    "分布",
  );
}

/* ---------- 共享值 ---------- */

function shared<T>(read: (n: DocNode) => T): T | Mixed {
  const list = nodes.value;
  if (list.length === 0) return MIXED;
  const first = read(list[0]);
  return list.every((n) => JSON.stringify(read(n)) === JSON.stringify(first)) ? first : MIXED;
}

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function numValue(v: number | Mixed): string {
  return v === MIXED ? "" : fmt(v);
}

function num(e: Event): number {
  return Number((e.target as HTMLInputElement).value);
}

function boolOf(e: Event): boolean {
  return (e.target as HTMLInputElement).checked;
}

function nameOf(n: DocNode): string {
  return n.name;
}

const tokenNames = computed(() => {
  void ui.version;
  return Object.keys(docStore.doc.tokens).filter((k) => docStore.doc.tokens[k].type === "color");
});

/* ---------- 元信息与几何 ---------- */

function typeLabel(n: DocNode): string {
  if (n.type === "polygon") return (n.sides ?? 3) === 3 ? "三角形" : "多边形";
  return n.type;
}

function setName(e: Event): void {
  const n = node.value;
  if (!n) return;
  const name = (e.target as HTMLInputElement).value.replace(/\s+/g, " ").trim();
  if (!name || name === n.name) return;
  dispatch({ type: "node.update", params: { nodeId: n.id, patch: { name } } }, "rename-node");
}

function setNum(key: "x" | "y" | "width" | "height", e: Event): void {
  const n = node.value;
  if (!n) return;
  const parent = n.parentId ? docStore.doc.nodes[n.parentId] : null;
  const patch: Partial<DocNode> = { [key]: num(e) };
  // 在布局容器里改尺寸 = 先转 fixed（Q32）
  if (parent?.layout && !n.layoutAbsolute) {
    if (key === "width") patch.layoutSizingW = "fixed";
    if (key === "height") patch.layoutSizingH = "fixed";
  }
  dispatch({ type: "node.update", params: { nodeId: n.id, patch } }, "inspect");
}

function setRotation(e: Event): void {
  applyNodes(() => ({ rotation: num(e) }));
}

function setOpacity(e: Event): void {
  const v = Math.max(0, Math.min(1, num(e) / 100));
  applyNodes(() => ({ opacity: v }));
}

function toggleVisible(): void {
  const next = !(node.value?.visible ?? true);
  applyNodes(() => ({ visible: next }));
}

function toggleLock(): void {
  const next = !(node.value?.locked ?? false);
  dispatch(
    {
      type: "node.update",
      params: { nodeId: node.value!.id, patch: { locked: next } },
    },
    "lock",
  );
}

function toggleClip(): void {
  const next = !(node.value?.clip ?? false);
  applyNodes(() => ({ clip: next }));
}

/* ---------- 颜色 ---------- */

function fillTokenOf(n: DocNode): string {
  if (!n.style.fill) return "";
  return n.style.fill.token ?? "__custom";
}

function strokeTokenOf(n: DocNode): string {
  if (!n.style.stroke) return "";
  return n.style.stroke.token ?? "__custom";
}

function colorOf(paint: { token?: string; value?: string } | null | undefined): string {
  const resolved = resolvePaint(docStore.doc, paint) ?? "";
  return /^#[0-9a-fA-F]{6,8}$/.test(resolved) ? resolved.slice(0, 7) : "#000000";
}

function setFill(e: Event): void {
  const value = (e.target as HTMLSelectElement).value;
  applyStyle((style) => ({
    ...style,
    fill: value === "" ? null : value === "__custom" ? { value: resolvedCustom(style.fill ?? undefined) } : { token: value },
  }));
}

function setStroke(e: Event): void {
  const value = (e.target as HTMLSelectElement).value;
  applyStyle((style) => ({
    ...style,
    stroke: value === "" ? undefined : value === "__custom" ? { value: resolvedCustom(style.stroke) } : { token: value },
  }));
}

function resolvedCustom(paint: { token?: string; value?: string } | undefined): string {
  const resolved = resolvePaint(docStore.doc, paint);
  return /^#[0-9a-fA-F]{6,8}$/.test(resolved ?? "") ? (resolved as string) : "#000000";
}

function setCustomPaint(kind: "fill" | "stroke", e: Event): void {
  const value = (e.target as HTMLInputElement).value.trim();
  if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) return;
  applyStyle((style) => ({
    ...style,
    [kind]: { value },
  }));
}

function setStrokeWidth(e: Event): void {
  applyStyle((style) => ({ ...style, strokeWidth: Math.max(0, num(e)), strokeWidthToken: undefined }));
}

/* ---------- 效果 ---------- */

const supportsEffects = computed(() => nodes.value.length === 1 && node.value?.type !== "page");

function effectsOf(n: DocNode | null): Effect[] {
  return n?.style.effects ?? [];
}

function effectLabel(type: EffectType): string {
  return EFFECT_LABELS[type];
}

function isShadowEffectOf(effect: Effect): effect is ShadowEffect {
  return effect.type === "drop-shadow" || effect.type === "inner-shadow";
}

function shadowColorOf(effect: ShadowEffect): string {
  return colorOf(effect.color);
}

function addEffect(type: string): void {
  if (!type) return;
  applyStyle((style) => ({ ...style, effects: [...(style.effects ?? []), createEffect(type as EffectType)] }), "effect-add");
}

/** 效果列表整体替换：一次改动 = 一步撤销。 */
function patchEffect(index: number, patch: Record<string, unknown>, label = "effect"): void {
  applyStyle((style) => {
    const list = [...(style.effects ?? [])];
    const current = list[index];
    if (!current) return style;
    list[index] = sanitizeEffect({ ...current, ...patch } as Effect);
    return { ...style, effects: list };
  }, label);
}

function removeEffect(index: number): void {
  applyStyle((style) => {
    const list = [...(style.effects ?? [])];
    list.splice(index, 1);
    return { ...style, effects: list.length > 0 ? list : undefined };
  }, "effect-remove");
}

function toggleEffect(index: number): void {
  const current = effectsOf(node.value)[index];
  if (!current) return;
  patchEffect(index, { visible: !current.visible }, "effect-toggle");
}

function setEffectNumber(index: number, field: string, e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  patchEffect(index, { [field]: value });
}

function setEffectColorToken(index: number, e: Event): void {
  const token = (e.target as HTMLSelectElement).value;
  if (token === "__custom") {
    const current = effectsOf(node.value)[index];
    const value = current && isShadowEffectOf(current) ? resolvedCustom(current.color) : "#0f172a";
    patchEffect(index, { color: { value } }, "effect-color");
    return;
  }
  patchEffect(index, { color: token ? { token } : { value: "#0f172a" } }, "effect-color");
}

function setEffectColorValue(index: number, e: Event): void {
  const value = (e.target as HTMLInputElement).value.trim();
  if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) return;
  patchEffect(index, { color: { value } }, "effect-color");
}

/* ---------- 圆角 ---------- */

const radiusExpanded = ref(false);

function radiusOf(n: DocNode): CornerRadius {
  // 展示与编辑都以解析后的值为准（Token 优先，未绑定回退字面量）
  return resolveNumericStyle(docStore.doc, n.style).cornerRadius ?? ZERO_CORNER_RADIUS;
}

function uniform(values: Array<number | null>): number | Mixed {
  if (values.length === 0) return MIXED;
  if (values.some((v) => v === null)) return MIXED;
  const first = values[0] as number;
  return values.every((v) => v === first) ? first : MIXED;
}

function radiusUnified(): number | Mixed {
  return uniform(
    nodes.value.map((n) => {
      const r = radiusOf(n);
      return r.topLeft === r.topRight && r.topLeft === r.bottomRight && r.topLeft === r.bottomLeft ? r.topLeft : null;
    }),
  );
}

function setRadiusAll(e: Event): void {
  const value = Math.max(0, num(e));
  applyStyle((style) => ({
    ...style,
    cornerRadius: { topLeft: value, topRight: value, bottomRight: value, bottomLeft: value },
    // 手改统一值 = 解除四角的 Token 绑定
    cornerRadiusTokens: undefined,
  }));
}

function setRadiusCorner(key: keyof CornerRadius, e: Event): void {
  const value = Math.max(0, num(e));
  applyStyle((style) => {
    const radius = { ...radiusOf({ style } as DocNode), [key]: value };
    const tokens = style.cornerRadiusTokens ? { ...style.cornerRadiusTokens } : undefined;
    if (tokens) delete tokens[key];
    return {
      ...style,
      cornerRadius: radius,
      cornerRadiusTokens: tokens && Object.keys(tokens).length > 0 ? tokens : undefined,
    };
  });
}

/* ---------- 自动布局 ---------- */

const paddingExpanded = ref(false);

function layoutOf(n: DocNode): LayoutSpec | undefined {
  return n.layout ? resolveNumericLayout(docStore.doc, n.layout) : undefined;
}

function setLayout(patch: Partial<LayoutSpec>): void {
  const n = node.value;
  if (!n) return;
  const layout = { ...(n.layout ?? createLayoutSpec()), ...patch };
  // 手改字面量 = 解除对应的 Token 绑定
  if (patch.gap !== undefined) delete layout.gapToken;
  if (patch.crossGap !== undefined) delete layout.crossGapToken;
  dispatch({ type: "node.update", params: { nodeId: n.id, patch: { layout } } }, "layout");
}

function addLayout(): void {
  if (!node.value) return;
  const layout = createLayoutSpec({
    direction: "vertical",
    gap: 12,
    padding: { top: 12, right: 12, bottom: 12, left: 12 },
  });
  dispatch({ type: "node.update", params: { nodeId: node.value.id, patch: { layout } } }, "layout");
}

function removeLayout(): void {
  if (!node.value) return;
  dispatch({ type: "node.update", params: { nodeId: node.value.id, patch: { layout: undefined } } }, "layout");
}

function paddingOf(n: DocNode): Padding {
  return (n.layout ? resolveNumericLayout(docStore.doc, n.layout).padding : undefined) ?? ZERO_PADDING;
}

function paddingUnified(): number | Mixed {
  return uniform(
    nodes.value.map((n) => {
      const p = paddingOf(n);
      return p.top === p.right && p.top === p.bottom && p.top === p.left ? p.top : null;
    }),
  );
}

function setPaddingAll(e: Event): void {
  const v = Math.max(0, num(e));
  setLayout({ padding: { top: v, right: v, bottom: v, left: v }, paddingTokens: undefined });
}

function setPaddingSide(side: keyof Padding, e: Event): void {
  const n = node.value;
  if (!n) return;
  const padding = { ...paddingOf(n), [side]: Math.max(0, num(e)) };
  const tokens = n.layout?.paddingTokens ? { ...n.layout.paddingTokens } : undefined;
  if (tokens) delete tokens[side];
  setLayout({ padding, paddingTokens: tokens && Object.keys(tokens).length > 0 ? tokens : undefined });
}

function setSizing(axis: "W" | "H", e: Event): void {
  const n = node.value;
  if (!n) return;
  const value = (e.target as HTMLSelectElement).value as "fixed" | "hug" | "fill";
  const patch: Partial<DocNode> = axis === "W" ? { layoutSizingW: value } : { layoutSizingH: value };
  dispatch({ type: "node.update", params: { nodeId: n.id, patch } }, "layout");
}

function setMainAlign(e: Event): void {
  setLayout({ mainAlign: (e.target as HTMLSelectElement).value as LayoutSpec["mainAlign"] });
}

function setCrossAlign(e: Event): void {
  setLayout({ crossAlign: (e.target as HTMLSelectElement).value as LayoutSpec["crossAlign"] });
}

function setAlignContent(e: Event): void {
  setLayout({ alignContent: (e.target as HTMLSelectElement).value as LayoutSpec["alignContent"] });
}

function setSides(e: Event): void {
  const sides = Math.max(3, Math.min(12, Math.round(num(e))));
  applyNodes(() => ({ sides }));
}

function setLayoutNumber(key: "layoutMinW" | "layoutMinH" | "layoutMaxW" | "layoutMaxH", e: Event): void {
  const n = node.value;
  if (!n) return;
  const raw = (e.target as HTMLInputElement).value;
  const patch: Partial<DocNode> = { [key]: raw === "" ? undefined : Number(raw) };
  dispatch({ type: "node.update", params: { nodeId: n.id, patch } }, "layout");
}

function toggleAbsolute(e: Event): void {
  const n = node.value;
  if (!n) return;
  dispatch(
    { type: "node.update", params: { nodeId: n.id, patch: { layoutAbsolute: boolOf(e) } } },
    "layout",
  );
}

/* ---------- 文本 ---------- */

const textDraft = ref("");
const textAreaEl = ref<HTMLTextAreaElement | null>(null);

watch(
  () => [node.value?.id, node.value?.text, ui.version] as const,
  () => {
    textDraft.value = node.value?.text ?? "";
    requestAnimationFrame(() => autoGrowTextArea(textAreaEl.value));
  },
  { immediate: true },
);

function autoGrowTextArea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}

function onTextAreaInput(e: Event): void {
  const el = e.target as HTMLTextAreaElement;
  textDraft.value = el.value;
  autoGrowTextArea(el);
}

function onTextAreaKey(e: KeyboardEvent): void {
  if (e.isComposing) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    commitText();
    (e.target as HTMLTextAreaElement).blur();
  } else if (e.key === "Escape") {
    e.preventDefault();
    textDraft.value = node.value?.text ?? "";
    (e.target as HTMLTextAreaElement).blur();
  }
}

function textPatch(n: DocNode, style: NodeStyle, text: string): Partial<DocNode> {
  const patch: Partial<DocNode> = { text };
  const mode = n.textAutoResize ?? "auto-width";
  if (mode !== "fixed") {
    const size = textSizeOf(n, style, text, docStore.doc);
    if (mode === "auto-width") patch.width = size.width;
    patch.height = size.height;
  }
  return patch;
}

function commitText(): void {
  const n = node.value;
  if (!n || n.type !== "text") return;
  const text = textDraft.value;
  if (text === (n.text ?? "")) return;
  dispatch(
    { type: "node.update", params: { nodeId: n.id, patch: textPatch(n, n.style, text) } },
    "inspect",
  );
}

/** 文本样式变更：同步重算自动尺寸；手改字面量时解除对应的 Token 绑定。 */
function applyTextStyle(patch: Partial<NodeStyle>, label = "inspect"): void {
  const cmds: Command[] = [];
  for (const n of targets()) {
    if (n.type !== "text") continue;
    const style = { ...n.style, ...patch };
    for (const [literal, token] of TEXT_TOKEN_FIELDS) {
      if (patch[literal] !== undefined && patch[token] === undefined) delete style[token];
    }
    const next: Partial<DocNode> = { style };
    const mode = n.textAutoResize ?? "auto-width";
    if (mode !== "fixed") {
      const size = textSizeOf(n, style, n.text ?? "", docStore.doc);
      if (mode === "auto-width") next.width = size.width;
      next.height = size.height;
    }
    cmds.push({ type: "node.update", params: { nodeId: n.id, patch: next } });
  }
  if (cmds.length > 0) dispatch(cmds, label);
}

function setTextStyle(key: keyof NodeStyle, e: Event, parse: (v: string) => unknown = (v) => v): void {
  const raw = (e.target as HTMLInputElement | HTMLSelectElement).value;
  if (key === "lineHeightUnit") {
    const unit = raw as NodeStyle["lineHeightUnit"];
    const patch: Partial<NodeStyle> = { lineHeightUnit: unit };
    // 已绑定行高 Token 时，切单位不应顺手写一个字面量（那会解绑）
    if (!node.value?.style.lineHeightToken && unit !== "auto" && (node.value?.style.lineHeight ?? 0) === 0) {
      patch.lineHeight = unit === "px" ? Math.round((node.value?.style.fontSize ?? 20) * 1.4) : 140;
    }
    applyTextStyle(patch);
    return;
  }
  applyTextStyle({ [key]: parse(raw) } as Partial<NodeStyle>);
}

function setAutoResize(e: Event): void {
  const n = node.value;
  if (!n) return;
  const mode = (e.target as HTMLSelectElement).value as TextAutoResize;
  const patch: Partial<DocNode> = { textAutoResize: mode };
  if (mode !== "fixed") {
    const size = textSizeOf({ ...n, textAutoResize: mode }, n.style, n.text ?? "", docStore.doc);
    if (mode === "auto-width") patch.width = size.width;
    patch.height = size.height;
  }
  dispatch({ type: "node.update", params: { nodeId: n.id, patch } }, "inspect");
}

function setListType(e: Event): void {
  const n = node.value;
  if (!n) return;
  const listType = (e.target as HTMLSelectElement).value as ListType;
  const patch: Partial<DocNode> = { listType };
  if ((n.textAutoResize ?? "auto-width") !== "fixed") {
    const size = textSizeOf({ ...n, listType }, n.style, n.text ?? "", docStore.doc);
    if ((n.textAutoResize ?? "auto-width") === "auto-width") patch.width = size.width;
    patch.height = size.height;
  }
  dispatch({ type: "node.update", params: { nodeId: n.id, patch } }, "inspect");
}

function setTruncate(e: Event): void {
  const n = node.value;
  if (!n) return;
  dispatch({ type: "node.update", params: { nodeId: n.id, patch: { truncate: boolOf(e) } } }, "inspect");
}

const FONT_STACKS = [
  { label: "Geist（界面）", value: "'Geist Variable', 'PingFang SC', sans-serif" },
  { label: "Geist Mono（等宽）", value: "'Geist Mono Variable', ui-monospace, 'SF Mono', monospace" },
  { label: "系统无衬线", value: "ui-sans-serif, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { label: "系统衬线", value: "ui-serif, 'Songti SC', SimSun, serif" },
  { label: "系统等宽", value: "ui-monospace, 'SF Mono', Menlo, monospace" },
];

/* ---------- 路径 / 插槽 ---------- */

function canClosePath(n: DocNode): boolean {
  return Boolean(n.vector?.closed) || (n.vector?.anchors.length ?? 0) >= 3;
}

function setClosed(e: Event): void {
  const n = node.value;
  if (!n?.vector) return;
  const closed = boolOf(e);
  if (closed && n.vector.anchors.length < 3) return;
  dispatch({ type: "node.update", params: { nodeId: n.id, patch: { vector: { ...n.vector, closed } } } }, "inspect");
}

const copied = ref(false);
let copyTimer = 0;

function copyId(): void {
  if (!node.value) return;
  // 走主进程写剪贴板：渲染层的 navigator.clipboard 会被权限处理器拒绝（main/index.ts）
  window.sqraft.app.copyText(node.value.id);
  copied.value = true;
  window.clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => (copied.value = false), 1200);
}

/* ---------- 插槽 / 组件（沿用原有逻辑） ---------- */

const instanceOwner = computed(() => {
  void ui.version;
  const current = node.value;
  if (!current) return null;
  const info = findOverrideOwner(docStore.doc, current.id);
  if (!info) return null;
  return {
    instanceId: info.owner.id,
    isRoot: info.owner.id === current.id,
    count: Object.keys(info.owner.overrides ?? {}).length,
  };
});

function componentAncestorId(id: string): string | null {
  let cur = docStore.doc.nodes[id]?.parentId;
  while (cur) {
    const n = docStore.doc.nodes[cur];
    if (!n) return null;
    if (n.type === "component") return n.id;
    cur = n.parentId;
  }
  return null;
}

function hasSlotAncestor(id: string): boolean {
  let cur = docStore.doc.nodes[id]?.parentId;
  while (cur) {
    const n = docStore.doc.nodes[cur];
    if (!n) return false;
    if (n.type === "slot") return true;
    cur = n.parentId;
  }
  return false;
}

const canMakeSlot = computed(() => {
  void ui.version;
  const n = node.value;
  if (!n || multi.value || (n.type !== "frame" && n.type !== "group")) return false;
  if (!componentAncestorId(n.id)) return false;
  if (hasSlotAncestor(n.id)) return false;
  return !findOverrideOwner(docStore.doc, n.id);
});

function toSlot(): void {
  if (!node.value) return;
  try {
    dispatch({ type: "slot.create", params: { nodeId: node.value.id } }, "slot");
  } catch {
    /* 不满足约束时不改文档 */
  }
}

function clearSlot(): void {
  if (!node.value || node.value.type !== "slot") return;
  dispatch({ type: "slot.clear", params: { slotId: node.value.id } }, "slot-clear");
}

const componentContext = computed<{ component: DocNode; target: DocNode } | null>(() => {
  void ui.version;
  const current = node.value;
  if (!current || multi.value) return null;
  if (current.type === "component") return { component: current, target: current };
  let component: DocNode | null = null;
  let cur = current.parentId ? docStore.doc.nodes[current.parentId] : undefined;
  while (cur) {
    if (cur.type === "component") {
      component = cur;
      break;
    }
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  if (!component) return null;
  if (findOverrideOwner(docStore.doc, current.id)) return null;
  if (current.mainId && current.type !== "instance") return null;
  return { component, target: current };
});

function targetKey(target: DocNode): string {
  return target.type === "instance" ? target.id : (target.mainId ?? target.id);
}

const targetProp = computed<ComponentPropertyDef | null>(() => {
  const ctx = componentContext.value;
  if (!ctx) return null;
  return ctx.component.propertyDefs?.find((d) => d.targetMainId === targetKey(ctx.target)) ?? null;
});

const componentDefs = computed<ComponentPropertyDef[]>(() => {
  void ui.version;
  return node.value?.type === "component" ? (node.value.propertyDefs ?? []) : [];
});

const instanceProps = computed<{ instance: DocNode; defs: ComponentPropertyDef[] } | null>(() => {
  void ui.version;
  const current = node.value;
  if (!current || multi.value || current.type !== "instance" || !current.componentId) return null;
  const component = docStore.doc.nodes[current.componentId];
  if (!component || component.type !== "component") return null;
  return { instance: current, defs: component.propertyDefs ?? [] };
});

const allComponents = computed(() => {
  void ui.version;
  return Object.values(docStore.doc.nodes)
    .filter((n) => n.type === "component")
    .map((n) => ({ id: n.id, name: n.name }));
});

function propTypeLabel(type: string): string {
  return type === "text" ? "文本" : type === "boolean" ? "布尔" : "实例替换";
}

function defineProp(type: "text" | "boolean" | "instance"): void {
  const ctx = componentContext.value;
  if (!ctx) return;
  try {
    dispatch(
      {
        type: "property.define",
        params: { componentId: ctx.component.id, targetMainId: ctx.target.id, id: newId(), type },
      },
      "property",
    );
  } catch {
    /* 不满足约束时不改文档 */
  }
}

function renameDef(def: ComponentPropertyDef, e: Event): void {
  const ctx = componentContext.value;
  if (!ctx) return;
  const input = e.target as HTMLInputElement;
  try {
    dispatch(
      { type: "property.rename", params: { componentId: ctx.component.id, propertyId: def.id, name: input.value } },
      "property",
    );
  } catch {
    input.value = def.name;
  }
}

function deleteDef(def: ComponentPropertyDef): void {
  const ctx = componentContext.value;
  if (!ctx) return;
  dispatch({ type: "property.delete", params: { componentId: ctx.component.id, propertyId: def.id } }, "property");
}

function propValue(def: ComponentPropertyDef): string | boolean {
  const info = instanceProps.value;
  if (!info) return "";
  const value = info.instance.propValues?.[def.id];
  if (value !== undefined) return value;
  const master = docStore.doc.nodes[def.targetMainId];
  if (def.type === "text") return master?.text ?? "";
  if (def.type === "boolean") return master?.visible ?? true;
  return master?.componentId ?? "";
}

function hasPropValue(def: ComponentPropertyDef): boolean {
  const info = instanceProps.value;
  return Boolean(info && info.instance.propValues?.[def.id] !== undefined);
}

function setProp(def: ComponentPropertyDef, value: string | boolean | null): void {
  const info = instanceProps.value;
  if (!info) return;
  try {
    dispatch(
      { type: "property.set", params: { instanceId: info.instance.id, propertyId: def.id, value } },
      "property",
    );
  } catch {
    /* 非法值不改文档 */
  }
}

function onTextProp(def: ComponentPropertyDef, e: Event): void {
  setProp(def, (e.target as HTMLInputElement).value);
}

function onBoolProp(def: ComponentPropertyDef, e: Event): void {
  setProp(def, boolOf(e));
}

function onSwapProp(def: ComponentPropertyDef, e: Event): void {
  const value = (e.target as HTMLSelectElement).value;
  setProp(def, value || null);
}

function onSwapComponent(e: Event): void {
  const info = instanceProps.value;
  if (!info) return;
  const componentId = (e.target as HTMLSelectElement).value;
  if (!componentId) return;
  try {
    dispatch({ type: "instance.swap", params: { instanceId: info.instance.id, componentId } }, "instance-swap");
  } catch {
    (e.target as HTMLSelectElement).value = info.instance.componentId ?? "";
  }
}

function gotoMaster(): void {
  const componentId = instanceProps.value?.instance.componentId;
  if (!componentId) return;
  let cur: DocNode | undefined = docStore.doc.nodes[componentId];
  while (cur && cur.type !== "page") {
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  if (cur) {
    ui.activePageId = cur.id;
    ui.expandedPageId = cur.id;
  }
  hooks.focusNode(componentId);
}

function detachInstance(): void {
  const info = instanceProps.value;
  if (!info) return;
  dispatch({ type: "component.detach", params: { instanceId: info.instance.id } }, "detach");
}

const overrideView = computed(() => {
  void ui.version;
  const current = node.value;
  if (!current) return null;
  const info = findOverrideOwner(docStore.doc, current.id);
  if (!info) return null;
  const patch = info.owner.overrides?.[info.key];
  if (!patch) return null;
  const fields: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key === "style") {
      for (const sk of Object.keys(value ?? {})) fields.push(`style.${sk}`);
    } else {
      fields.push(key);
    }
  }
  return fields.length ? { instanceId: info.owner.id, mainId: info.key, fields } : null;
});

const outerOverrideView = computed(() => {
  void ui.version;
  const current = node.value;
  if (!current || current.type !== "instance") return null;
  const info = findOuterOverrideOwner(docStore.doc, current.id);
  if (!info) return null;
  const patch = info.owner.overrides?.[info.key];
  if (!patch) return null;
  const fields = Object.keys(patch);
  return fields.length ? { instanceId: info.owner.id, mainId: info.key, fields } : null;
});

const FIELD_LABELS: Record<string, string> = {
  text: "文案",
  name: "名称",
  width: "宽",
  height: "高",
  x: "X",
  y: "Y",
  rotation: "旋转",
  opacity: "不透明度",
  visible: "可见性",
  locked: "锁定",
  clip: "裁剪",
  layout: "布局",
  componentId: "组件",
  sides: "边数",
  vector: "路径",
  "style.fill": "填充",
  "style.stroke": "描边",
  "style.strokeWidth": "线宽",
  "style.cornerRadius": "圆角",
  "style.fontSize": "字号",
  "style.fontFamily": "字体",
  "style.fontWeight": "字重",
  "style.fontStyle": "斜体",
  "style.lineHeight": "行高",
  "style.letterSpacing": "字距",
  "style.paragraphSpacing": "段距",
  "style.textAlign": "对齐",
  "style.textCase": "大小写",
  "style.textDecoration": "装饰",
  propValues: "属性值",
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function resetField(field: string): void {
  const view = overrideView.value;
  if (!view) return;
  dispatch(
    { type: "instance.resetOverride", params: { instanceId: view.instanceId, mainId: view.mainId, fields: [field] } },
    "reset-override",
  );
}

function resetAllOverrides(): void {
  const owner = instanceOwner.value;
  if (!owner) return;
  dispatch({ type: "instance.resetOverride", params: { instanceId: owner.instanceId } }, "reset-override");
}

function resetOuterField(field: string): void {
  const view = outerOverrideView.value;
  if (!view) return;
  dispatch(
    { type: "instance.resetOverride", params: { instanceId: view.instanceId, mainId: view.mainId, fields: [field] } },
    "reset-override",
  );
}

  return {
    lockedChain,
    targets,
    applyNodes,
    applyStyle,
    shared,
    fmt,
    numValue,
    num,
    boolOf,
    nameOf,
    typeLabel,
    setName,
    setNum,
    setRotation,
    setOpacity,
    toggleVisible,
    toggleLock,
    toggleClip,
    fillTokenOf,
    strokeTokenOf,
    colorOf,
    setFill,
    setStroke,
    resolvedCustom,
    setCustomPaint,
    setStrokeWidth,
    supportsEffects,
    effectsOf,
    effectLabel,
    isShadowEffectOf,
    shadowColorOf,
    addEffect,
    removeEffect,
    toggleEffect,
    setEffectNumber,
    setEffectColorToken,
    setEffectColorValue,
    importedFamilies,
    weightOptions,
    fontInput,
    importFont,
    backgroundInput,
    setBackgroundImage,
    setBackgroundFit,
    clearBackgroundImage,
    selectionBounds,
    setBoundsNumber,
    showAlign,
    canAlign,
    canDistribute,
    layoutBound,
    align,
    distribute,
    radiusOf,
    uniform,
    radiusUnified,
    setRadiusAll,
    setRadiusCorner,
    layoutOf,
    ...tokenBindings,
    setLayout,
    addLayout,
    removeLayout,
    paddingOf,
    paddingUnified,
    setPaddingAll,
    setPaddingSide,
    setSizing,
    setMainAlign,
    setCrossAlign,
    setAlignContent,
    setSides,
    setLayoutNumber,
    toggleAbsolute,
    autoGrowTextArea,
    onTextAreaInput,
    onTextAreaKey,
    textPatch,
    commitText,
    applyTextStyle,
    setTextStyle,
    setAutoResize,
    setListType,
    setTruncate,
    canClosePath,
    setClosed,
    copyId,
    componentAncestorId,
    hasSlotAncestor,
    toSlot,
    clearSlot,
    targetKey,
    propTypeLabel,
    defineProp,
    renameDef,
    deleteDef,
    propValue,
    hasPropValue,
    setProp,
    onTextProp,
    onBoolProp,
    onSwapProp,
    onSwapComponent,
    gotoMaster,
    detachInstance,
    fieldLabel,
    resetField,
    resetAllOverrides,
    resetOuterField,
    MIXED,
    nodes,
    node,
    multi,
    allText,
    hasType,
    supportsFill,
    supportsStroke,
    supportsRadius,
    supportsClip,
    supportsLayout,
    supportsSizing,
    readonly,
    tokenNames,
    radiusExpanded,
    paddingExpanded,
    textDraft,
    textAreaEl,
    FONT_STACKS,
    copied,
    instanceOwner,
    canMakeSlot,
    componentContext,
    targetProp,
    componentDefs,
    instanceProps,
    allComponents,
    overrideView,
    outerOverrideView,
    FIELD_LABELS,
  };
}
