/**
 * 文档模型：扁平节点表 + 树不变量。
 * 详见 docs/architecture.md §3。本包不依赖任何浏览器/DOM API。
 */

import type { VectorPath } from "./vector";
import type { Effect } from "./effects";
import { effectPadding } from "./effects";

export type NodeId = string;

/** 当前文件格式版本：新增字段时 +1，并在 migrate 里补一段迁移。 */
export const CURRENT_FORMAT_VERSION = 4;

export type NodeType =
  | "page" | "frame" | "group" | "rect" | "ellipse" | "line"
  | "polygon" | "star" | "path" | "text" | "image"
  | "component" | "instance" | "slot";

/** 颜色引用：必须是 Token 引用或字面量。AI 工具层禁止字面量（见 ai-tools）。 */
export interface Paint {
  token?: string;
  value?: string;
}

/** 组件属性定义：从母版图层创建，绑定一个字段。 */
export interface ComponentPropertyDef {
  /** 稳定 id：改名不影响实例上的值 */
  id: string;
  /** 显示名，组件内唯一 */
  name: string;
  type: "text" | "boolean" | "instance";
  /** 绑定的母版节点 id */
  targetMainId: NodeId;
}

/** 四角圆角（模型只存四角；统一值是 UI 快捷）。 */
export interface CornerRadius {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

export const ZERO_CORNER_RADIUS: CornerRadius = {
  topLeft: 0,
  topRight: 0,
  bottomRight: 0,
  bottomLeft: 0,
};

/** 行高：auto 用 TEXT_LINE_HEIGHT；percent 以字号为基准。 */
export type LineHeightUnit = "auto" | "px" | "percent";
export type LetterSpacingUnit = "px" | "percent";
export type TextAlign = "left" | "center" | "right" | "justify";
export type TextVerticalAlign = "top" | "middle" | "bottom";
export type TextCase = "none" | "upper" | "lower" | "title";
export type TextDecoration = "none" | "underline" | "strikethrough";
export type FontStyle = "normal" | "italic";

export interface NodeStyle {
  fill?: Paint | null;
  stroke?: Paint;
  strokeWidth?: number;
  cornerRadius?: CornerRadius;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: FontStyle;
  lineHeight?: number;
  lineHeightUnit?: LineHeightUnit;
  letterSpacing?: number;
  letterSpacingUnit?: LetterSpacingUnit;
  paragraphSpacing?: number;
  textAlign?: TextAlign;
  textVerticalAlign?: TextVerticalAlign;
  textCase?: TextCase;
  textDecoration?: TextDecoration;
  /** 节点效果（有序，整体替换）：投影 / 内阴影 / 图层模糊 / 背景模糊 */
  effects?: Effect[];
}

/** 四边内边距：模型只存四边；统一值是 UI 快捷。 */
export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const ZERO_PADDING: Padding = { top: 0, right: 0, bottom: 0, left: 0 };

export type MainAlign = "start" | "center" | "end" | "space-between";
export type CrossAlign = "start" | "center" | "end" | "stretch";
export type AlignContent = "start" | "center" | "end" | "space-between" | "stretch";

export interface LayoutSpec {
  direction: "horizontal" | "vertical";
  gap: number;
  padding: Padding;
  mainAlign: MainAlign;
  crossAlign: CrossAlign;
  wrap: boolean;
  crossGap: number;
  alignContent: AlignContent;
}

/** 子项在父布局中的尺寸行为。 */
export type LayoutSizing = "fixed" | "hug" | "fill";
/** 文本尺寸模式。 */
export type TextAutoResize = "auto-width" | "auto-height" | "fixed";
export type ListType = "none" | "bulleted" | "numbered";

/**
 * 字段级覆盖：style 允许只覆盖子字段（如 fill），其余字段按 DocNode 的形状给。
 * 同步时先展开母版值，再叠加覆盖。
 */
export type NodeOverride = Omit<Partial<DocNode>, "style"> & { style?: Partial<NodeStyle> };

/**
 * 图片引用：位图字节存在 `.sqraft` 的 `assets/` 里（按内容哈希命名），
 * 文档只记 id 与原图尺寸；`crop` 是**原图像素坐标**下的可见区域，缺省等于整张图。
 */
export interface ImageRef {
  assetId: string;
  naturalWidth: number;
  naturalHeight: number;
  crop: Rect;
}

export interface DocNode {
  id: NodeId;
  type: NodeType;
  name: string;
  parentId: NodeId | null;
  children: NodeId[];
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** 0–1；按层叠（祖先 × 自身）生效 */
  opacity: number;
  visible: boolean;
  locked: boolean;
  /** 仅 frame/component：裁剪子节点到圆角边界 */
  clip: boolean;
  /** 自身在父自动布局里的尺寸行为（仅作子项时有意义） */
  layoutSizingW?: LayoutSizing;
  layoutSizingH?: LayoutSizing;
  layoutMinW?: number;
  layoutMinH?: number;
  layoutMaxW?: number;
  layoutMaxH?: number;
  /** 绝对定位：退出父布局排布，X/Y 相对容器左上角 */
  layoutAbsolute?: boolean;
  text?: string;
  /** 文本尺寸模式；缺省按 auto-width */
  textAutoResize?: TextAutoResize;
  /** 文本列表类型（整段） */
  listType?: ListType;
  /** fixed 高度下是否截断并显示省略号 */
  truncate?: boolean;
  /** instance → 主组件 id */
  componentId?: NodeId;
  /** 自动布局：仅 frame 可持有（自动布局的唯一宿主） */
  layout?: LayoutSpec;
  /** 矢量路径：仅 path 使用；锚点本地坐标，手柄为相对偏移 */
  vector?: VectorPath;
  /** 多边形边数：仅 polygon 使用，3–12（顶点由包围盒推导） */
  sides?: number;
  /** 组件接口定义：仅 component 使用 */
  propertyDefs?: ComponentPropertyDef[];
  /** 实例属性值：propId → 值（仅 instance） */
  propValues?: Record<string, string | boolean | NodeId>;
  /** 实例覆盖：mainId → 字段补丁（仅 instance） */
  overrides?: Record<NodeId, NodeOverride>;
  /** 实例内部节点指向的母版节点 id；实例根指向 componentId */
  mainId?: NodeId;
  /** 插槽：仅实例侧的 slot 使用，表示默认内容已被用户内容替换 */
  slotFilled?: boolean;
  /** 图片：仅 image 使用 */
  image?: ImageRef;
  /** 作为蒙版：遮罩同一父级里它上方相邻的兄弟（Figma 语义） */
  isMask?: boolean;
  /** 参考线：仅 page 使用，页面本地坐标（页面左上角为原点） */
  guides?: { x: number[]; y: number[] };
  style: NodeStyle;
}

export interface TokenEntry {
  type: "color" | "number";
  value: string | number;
}

export interface DocState {
  version: number;
  /** 文件格式版本；旧文件缺省按 1 处理 */
  formatVersion?: number;
  rootIds: NodeId[];
  nodes: Record<NodeId, DocNode>;
  /** Token 表：key 形如 "color/primary"（单一取值，无模式） */
  tokens: Record<string, TokenEntry>;
}

let idCounter = 0;
export function newId(): NodeId {
  idCounter += 1;
  return `n_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function createNode(type: NodeType, patch: Partial<DocNode> = {}): DocNode {
  const container = type === "frame" || type === "component";
  return {
    id: newId(),
    type,
    name: type,
    parentId: null,
    children: [],
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    // 新画板/组件默认裁剪内容；实例在物化时继承母版
    clip: container,
    layoutSizingW: "fixed",
    layoutSizingH: "fixed",
    textAutoResize: type === "text" ? "auto-width" : undefined,
    listType: type === "text" ? "none" : undefined,
    style: {},
    ...patch,
  };
}

/** 文本行高倍数：渲染器与 UI 测量共用，保证行内编辑与画布一致。 */
export const TEXT_LINE_HEIGHT = 1.4;

export const DEFAULT_PAGE_WIDTH = 1440;
export const DEFAULT_PAGE_HEIGHT = 1024;
/** 页面自由摆放时的新建间距 */
export const PAGE_GAP = 160;

export function createEmptyDoc(): DocState {
  const page = createNode("page", {
    name: "页面 1",
    x: 0,
    y: 0,
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT,
  });
  return {
    version: 1,
    formatVersion: CURRENT_FORMAT_VERSION,
    rootIds: [page.id],
    nodes: { [page.id]: page },
    tokens: {
      "color/primary": { type: "color", value: "#3366ff" },
      "color/surface": { type: "color", value: "#ffffff" },
      "color/text": { type: "color", value: "#1a1a1a" },
      "radius/md": { type: "number", value: 8 },
    },
  };
}

/** 解析 Paint → 具体 CSS 值。 */
export function resolvePaint(state: DocState, paint: Paint | null | undefined): string | undefined {
  if (!paint) return undefined;
  if (paint.token) {
    const entry = state.tokens[paint.token];
    if (!entry) return "#ff00ff"; // 缺失 Token 用洋红示警
    return String(entry.value);
  }
  return paint.value;
}

/** 子树前序遍历（含自身）。 */
export function walkSubtree(state: DocState, id: NodeId, visit: (n: DocNode) => void): void {
  const node = state.nodes[id];
  if (!node) return;
  visit(node);
  for (const c of node.children) walkSubtree(state, c, visit);
}

export function firstPageId(state: DocState): NodeId | null {
  return state.rootIds[0] ?? null;
}

/** 文档全部页面（rootIds 即页面）。 */
export function getPages(state: DocState): DocNode[] {
  return state.rootIds.map((id) => state.nodes[id]).filter(Boolean);
}

/** 生成不重复的页面默认名："页面 N"。 */
export function nextPageName(state: DocState): string {
  const used = new Set(getPages(state).map((p) => p.name));
  let n = getPages(state).length + 1;
  while (used.has(`页面 ${n}`)) n += 1;
  return `页面 ${n}`;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 节点在画布世界坐标中的包围盒（累加祖先偏移，忽略旋转）。 */
export function worldRect(state: DocState, id: NodeId): Rect | null {
  const node = state.nodes[id];
  if (!node) return null;
  const chain: DocNode[] = [];
  let cur: DocNode | undefined = node;
  while (cur) {
    chain.push(cur);
    cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
  }
  let x = 0;
  let y = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    x += chain[i].x;
    y += chain[i].y;
  }
  return { x, y, width: node.width, height: node.height };
}

/** 节点的累计旋转角（自身 + 祖先，度数）。 */
export function worldRotation(state: DocState, id: NodeId): number {
  let angle = 0;
  let cur: DocNode | undefined = state.nodes[id];
  while (cur) {
    angle += cur.rotation || 0;
    cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
  }
  return angle;
}

export interface WorldPoint {
  x: number;
  y: number;
}

export interface QuadGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 节点在画布世界坐标中的旋转四边形（左上、右上、右下、左下）。
 * `geometry` 可覆盖节点自身的局部矩形（缩放预览用），祖先变换照常累加。
 * 命中与选中框用它；页面吸附等只需要轴对齐包围盒的地方继续用 worldRect。
 */
export function worldQuad(state: DocState, id: NodeId, geometry?: QuadGeometry): WorldPoint[] | null {
  const node = state.nodes[id];
  if (!node) return null;
  const chain: DocNode[] = [];
  let cur: DocNode | undefined = node;
  while (cur) {
    chain.push(cur);
    cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
  }
  const base = geometry ?? { x: node.x, y: node.y, width: node.width, height: node.height };
  // 从节点本地坐标开始，逐层（自身 → 祖先）变换到父坐标系
  let points: WorldPoint[] = [
    { x: 0, y: 0 },
    { x: base.width, y: 0 },
    { x: base.width, y: base.height },
    { x: 0, y: base.height },
  ];
  for (let i = 0; i < chain.length; i++) {
    const n = chain[i];
    const gx = i === 0 ? base.x : n.x;
    const gy = i === 0 ? base.y : n.y;
    const gw = i === 0 ? base.width : n.width;
    const gh = i === 0 ? base.height : n.height;
    const angle = ((n.rotation || 0) * Math.PI) / 180;
    const cx = gx + gw / 2;
    const cy = gy + gh / 2;
    points = points.map((p) => {
      const px = p.x + gx;
      const py = p.y + gy;
      if (!angle) return { x: px, y: py };
      const dx = px - cx;
      const dy = py - cy;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    });
  }
  return points;
}

/**
 * 节点整棵子树在页面坐标系里的绘制包围盒，并入每个节点自身的效果外扩。
 * 供「组隔离」的离屏层定尺寸：旋转按外接框算，略大于实际，宁大勿裁。
 */
export function subtreeWorldBounds(state: DocState, id: NodeId): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  walkSubtree(state, id, (n) => {
    const quad = worldQuad(state, n.id);
    if (!quad) return;
    const pad = effectPadding(n.style.effects);
    for (const p of quad) {
      if (p.x - pad < minX) minX = p.x - pad;
      if (p.y - pad < minY) minY = p.y - pad;
      if (p.x + pad > maxX) maxX = p.x + pad;
      if (p.y + pad > maxY) maxY = p.y + pad;
    }
  });
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** 图片的完整裁切区域（原图像素）。 */
export function fullImageCrop(ref: Pick<ImageRef, "naturalWidth" | "naturalHeight">): Rect {
  return {
    x: 0,
    y: 0,
    width: Math.max(1, ref.naturalWidth),
    height: Math.max(1, ref.naturalHeight),
  };
}

/**
 * 蒙版的绘制计划：`isMask` 的节点不单独出现，它用自己的形状裁掉**后一位**兄弟
 * （绘制顺序 = 从下往上，所以"后一位"就是视觉上盖在它上面的那一层，Figma 语义）。
 *
 * 放在 core 是为了能被测试覆盖：渲染器只按计划派发，不自己推配对规则。
 * 末尾没有兄弟的蒙版被忽略（与 Figma 一致：没有可遮罩的图层就不显示）。
 */
export type MaskPlanEntry =
  | { kind: "plain"; id: NodeId }
  | { kind: "masked"; maskId: NodeId; targetId: NodeId };

export function maskPlan(children: readonly NodeId[], isMask: (id: NodeId) => boolean): MaskPlanEntry[] {
  const out: MaskPlanEntry[] = [];
  for (let i = 0; i < children.length; i += 1) {
    const id = children[i];
    if (isMask(id)) {
      const targetId = children[i + 1];
      // 没有兄弟：蒙版本身不画，也不消耗后面的节点
      if (targetId !== undefined) {
        out.push({ kind: "masked", maskId: id, targetId });
        i += 1;
      }
      continue;
    }
    out.push({ kind: "plain", id });
  }
  return out;
}

/**
 * 图片节点当前的裁切区域：缺省等于整图，越界/过小时夹回图片范围。
 * 渲染与命中都用它，避免历史文档里的脏值把图拉到画布外。
 */
export function imageCropOf(node: DocNode): Rect {
  const ref = node.image;
  if (!ref) return { x: 0, y: 0, width: 1, height: 1 };
  const full = fullImageCrop(ref);
  const crop = ref.crop ?? full;
  const width = Math.max(1, Math.min(crop.width, full.width));
  const height = Math.max(1, Math.min(crop.height, full.height));
  return {
    x: Math.max(0, Math.min(crop.x, full.width - width)),
    y: Math.max(0, Math.min(crop.y, full.height - height)),
    width,
    height,
  };
}

/** 四角圆角归一化：缺省视为 0。 */
export function cornerRadiusOf(style: NodeStyle | undefined): CornerRadius {
  return style?.cornerRadius ?? ZERO_CORNER_RADIUS;
}

/** 四边 padding 归一化：缺省视为 0。 */
export function paddingOf(spec: LayoutSpec | undefined): Padding {
  return spec?.padding ?? ZERO_PADDING;
}

/** 自动布局默认值（新建容器或添加布局时使用）。 */
export function createLayoutSpec(patch: Partial<LayoutSpec> = {}): LayoutSpec {
  return {
    direction: "vertical",
    gap: 0,
    padding: { ...ZERO_PADDING },
    mainAlign: "start",
    crossAlign: "start",
    wrap: false,
    crossGap: 0,
    alignContent: "start",
    ...patch,
  };
}

/** 新建容器的默认自动布局：纵向、gap 10、四边 padding 10（对齐 Figma 开启自动布局的默认值）。 */
export function defaultLayoutSpec(): LayoutSpec {
  return createLayoutSpec({
    direction: "vertical",
    gap: 10,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
  });
}

/**
 * 新建容器的默认布局：只用于“从工具栏 / AI 新建”的入口。
 * 由既有节点转成的组件、实例物化、历史文档迁移都保持原几何，不套默认布局。
 */
export function defaultLayoutFor(type: NodeType): LayoutSpec | undefined {
  return type === "frame" || type === "component" ? defaultLayoutSpec() : undefined;
}

/** 新建页面的摆放位置：最右侧页面之右，与首屏顶部对齐。 */
export function nextPagePosition(state: DocState): { x: number; y: number } {
  const pages = getPages(state);
  if (pages.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...pages.map((p) => p.x + p.width));
  const top = Math.min(...pages.map((p) => p.y));
  return { x: right + PAGE_GAP, y: top };
}
