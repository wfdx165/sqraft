/**
 * 文档模型：扁平节点表 + 树不变量。
 * 详见 docs/architecture.md §3。本包不依赖任何浏览器/DOM API。
 */

import type { VectorPath } from "./vector";

export type NodeId = string;

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

export interface NodeStyle {
  fill?: Paint | null;
  stroke?: Paint;
  strokeWidth?: number;
  cornerRadius?: number;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  lineHeight?: number;
  textAlign?: "left" | "center" | "right";
}

export interface LayoutSpec {
  direction: "horizontal" | "vertical";
  gap: number;
  padding: number;
  mainAlign: "start" | "center" | "end" | "space-between";
  crossAlign: "start" | "center" | "end" | "stretch";
}

/**
 * 字段级覆盖：style 允许只覆盖子字段（如 fill），其余字段按 DocNode 的形状给。
 * 同步时先展开母版值，再叠加覆盖。
 */
export type NodeOverride = Omit<Partial<DocNode>, "style"> & { style?: Partial<NodeStyle> };

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
  visible: boolean;
  locked: boolean;
  text?: string;
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
  style: NodeStyle;
}

export interface TokenEntry {
  type: "color" | "number";
  value: string | number;
}

export interface DocState {
  version: number;
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
    visible: true,
    locked: false,
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

/** 新建页面的摆放位置：最右侧页面之右，与首屏顶部对齐。 */
export function nextPagePosition(state: DocState): { x: number; y: number } {
  const pages = getPages(state);
  if (pages.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...pages.map((p) => p.x + p.width));
  const top = Math.min(...pages.map((p) => p.y));
  return { x: right + PAGE_GAP, y: top };
}
