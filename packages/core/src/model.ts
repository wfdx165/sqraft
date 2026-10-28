/**
 * 文档模型：扁平节点表 + 树不变量。
 * 详见 docs/architecture.md §3。本包不依赖任何浏览器/DOM API。
 */

export type NodeId = string;

export type NodeType =
  | "page" | "frame" | "group" | "rect" | "ellipse" | "line"
  | "polygon" | "star" | "path" | "text" | "image"
  | "component" | "instance";

/** 颜色引用：必须是 Token 引用或字面量。AI 工具层禁止字面量（见 ai-tools）。 */
export interface Paint {
  token?: string;
  value?: string;
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

export function createEmptyDoc(): DocState {
  const page = createNode("page", { name: "页面 1", width: 0, height: 0 });
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
