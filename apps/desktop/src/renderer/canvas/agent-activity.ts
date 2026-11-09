/**
 * agent 活动的画布反馈：改动的最外层节点描边 + 呼吸/淡出。
 *
 * 状态刻意放在普通可变对象里（和 `vp`、`drag` 一样），不进 Vue 响应式——
 * 画布热路径每帧直接读它；需要重绘时显式调 `hooks.requestRedraw()`。
 */
import { unionRects, worldRect, type DocNode, type DocState, type NodeId, type Rect } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";

/** agent 描边色：避开选中的 indigo 与库对象的紫（RGB 分量便于按呼吸/淡出合成 alpha） */
export const AGENT_ACCENT_RGB = "14, 165, 233";
export const AGENT_ACCENT = `rgb(${AGENT_ACCENT_RGB})`;
/** 调用结束后的淡出时长（比画布定位脉冲的 620ms 更收敛） */
export const AGENT_FADE_MS = 480;
/** 呼吸周期：慢到不会让人以为在闪烁，又能看出"还在动" */
export const AGENT_BREATH_MS = 900;
/** 超过这个数量就不逐个描边，改画整体包围盒（一次建几十个兄弟节点时别满屏虚线） */
export const AGENT_MAX_RECTS = 12;

export interface AgentActivityState {
  /** 本次调用要标注的节点包围盒（文档坐标，已是最外层） */
  rects: Rect[];
  /** 改动落在哪一页（跨页跳转用）；纯读操作或使不上时为 null */
  pageId: NodeId | null;
  /** 调用是否还在执行 */
  active: boolean;
  /** 淡出起点（`performance.now()`）；未结束时为 0 */
  fadeStart: number;
}

export const agentActivity: AgentActivityState = {
  rects: [],
  pageId: null,
  active: false,
  fadeStart: 0,
};

export function beginAgentActivity(): void {
  agentActivity.active = true;
  agentActivity.rects = [];
  agentActivity.pageId = null;
  agentActivity.fadeStart = 0;
}

export function setAgentTargets(rects: Rect[], pageId: NodeId | null): void {
  agentActivity.rects = rects;
  agentActivity.pageId = pageId;
}

export function endAgentActivity(now = performance.now()): void {
  agentActivity.active = false;
  agentActivity.fadeStart = now;
}

export function resetAgentActivity(): void {
  agentActivity.active = false;
  agentActivity.rects = [];
  agentActivity.pageId = null;
  agentActivity.fadeStart = 0;
}

/** 这一帧还该不该为了描边继续重绘；给了视口就顺带跳过"根本看不见"的动画。 */
export function agentFxActive(now = performance.now(), vp?: Viewport): boolean {
  if (agentActivity.rects.length === 0) return false;
  if (!agentActivity.active && now - agentActivity.fadeStart >= AGENT_FADE_MS) return false;
  if (!vp) return true;
  const view = { x: vp.x, y: vp.y, width: vp.width / vp.zoom, height: vp.height / vp.zoom };
  return agentActivity.rects.some((rect) => rectInViewport(rect, view));
}

/** 改动是否落在"别的页"：只有编辑模式才有当前页概念，拖动模式下视口可以同时看到多页。 */
export function isCrossPage(
  pageId: NodeId | null,
  activePageId: NodeId | null,
  editing: boolean,
): boolean {
  return editing && pageId !== null && pageId !== activePageId;
}

/**
 * 只保留"最外层"的改动节点：祖先也在改动集合里的后代跳过。
 * 建一棵子树时只描它的根框，语义是"这里长出了一块东西"，而不是逐个零件。
 *
 * 页面不算"包含"：空文档里 agent 建节点时会顺带建页，
 * 若让页面覆盖它，真正新建的节点就永远描不出来（页面本身由 `markRects` 跳过）。
 */
export function outermostNodes(ids: Iterable<NodeId>, nodes: Record<NodeId, DocNode>): NodeId[] {
  const changed = new Set<NodeId>();
  for (const id of ids) if (nodes[id]) changed.add(id);

  const result: NodeId[] = [];
  for (const id of changed) {
    let parent = nodes[id]?.parentId ?? null;
    let covered = false;
    while (parent) {
      const ancestor = nodes[parent];
      if (!ancestor) break;
      if (ancestor.type !== "page" && changed.has(parent)) {
        covered = true;
        break;
      }
      parent = ancestor.parentId ?? null;
    }
    if (!covered) result.push(id);
  }
  return result;
}

/** 节点所属的页面（自己就是页面时返回自己）；不在任何页面下（如根级主组件）返回 null。 */
export function pageOf(nodes: Record<NodeId, DocNode>, id: NodeId): NodeId | null {
  let cursor: NodeId | null = id;
  while (cursor) {
    const node: DocNode | undefined = nodes[cursor];
    if (!node) return null;
    if (node.type === "page") return node.id;
    cursor = node.parentId ?? null;
  }
  return null;
}

/** 把节点集合收成描边矩形（世界坐标）；页面本身不描（整页虚线没有信息量），数量过多时退化成整体包围盒。 */
export function markRects(ids: readonly NodeId[], doc: DocState): Rect[] {
  const rects: Rect[] = [];
  for (const id of ids) {
    if (doc.nodes[id]?.type === "page") continue;
    const rect = worldRect(doc, id);
    if (rect) rects.push(rect);
  }
  if (rects.length <= AGENT_MAX_RECTS) return rects;
  const merged = unionRects(rects);
  return merged ? [merged] : [];
}

/** 矩形是否与视口相交（文档坐标）。 */
export function rectInViewport(rect: Rect, view: Rect): boolean {
  return (
    rect.x < view.x + view.width &&
    rect.x + rect.width > view.x &&
    rect.y < view.y + view.height &&
    rect.y + rect.height > view.y
  );
}

export function drawAgentOverlay(
  g: CanvasRenderingContext2D,
  vp: Viewport,
  now = performance.now(),
): void {
  const { rects, active, fadeStart } = agentActivity;
  if (rects.length === 0) return;
  const fade = active ? 0 : Math.min(1, (now - fadeStart) / AGENT_FADE_MS);
  if (fade >= 1) return;

  const breath = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin((now / AGENT_BREATH_MS) * Math.PI * 2));
  const alpha = breath * (1 - fade);

  g.save();
  g.strokeStyle = `rgba(${AGENT_ACCENT_RGB}, ${alpha})`;
  g.lineWidth = 1.5;
  g.setLineDash([5, 4]);
  g.shadowColor = `rgba(${AGENT_ACCENT_RGB}, ${0.35 * (1 - fade)})`;
  g.shadowBlur = 10;
  for (const rect of rects) {
    const a = worldToScreen(vp, rect.x, rect.y);
    const b = worldToScreen(vp, rect.x + rect.width, rect.y + rect.height);
    g.strokeRect(a.x + 0.5, a.y + 0.5, Math.max(1, b.x - a.x - 1), Math.max(1, b.y - a.y - 1));
  }
  g.restore();
}
