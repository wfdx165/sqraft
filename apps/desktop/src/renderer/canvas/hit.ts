/**
 * 画布命中检测：页面、实例上下文、旋转、裁剪、锁定与插槽落点。
 * 纯查询，不改文档；视口通过参数传入，UI 状态读 store 单例。
 */
import {
  findOverrideOwner,
  hitPolygon,
  hitVector,
  polygonPoints,
  worldRect,
  type DocNode,
  type NodeId,
} from "@sqraft/core";
import type { Viewport } from "@sqraft/render";
import { docStore, ui } from "../store";

/** 点（父局部坐标）→ 子节点本地坐标（逆旋转绕自身中心）。 */
export function toLocal(node: DocNode, px: number, py: number): { x: number; y: number } {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const angle = (-(node.rotation || 0) * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: cx + dx * cos - dy * sin - node.x,
    y: cy + dx * sin + dy * cos - node.y,
  };
}

function insideBox(node: DocNode, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x <= node.width && y <= node.height;
}

/** 节点是否被锁定（自身或祖先）。 */
export function isLocked(nodeId: NodeId): boolean {
  let cur: DocNode | undefined = docStore.doc.nodes[nodeId];
  while (cur) {
    if (cur.locked) return true;
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  return false;
}

/**
 * 形状类节点的几何命中（路径 / 多边形 / 带 vector 的直线）。
 * 坐标已是节点本地坐标；返回 null 表示不是形状类节点。
 */
export function hitShapeAt(c: DocNode, lx: number, ly: number, tol: number): boolean | null {
  const isShape = c.type === "path" || c.type === "polygon" || (c.type === "line" && Boolean(c.vector));
  if (!isShape) return null;
  if (lx < -tol || ly < -tol || lx > c.width + tol || ly > c.height + tol) return false;
  const filled = Boolean(c.style.fill);
  if (!filled && !c.style.stroke && c.type !== "line") return false;
  if (c.type === "path" && c.vector) return hitVector(c.vector, lx, ly, tol, filled);
  if (c.type === "polygon") return hitPolygon(polygonPoints(c.sides, c.width, c.height), lx, ly, tol, filled);
  if (c.type === "line" && c.vector) return hitVector(c.vector, lx, ly, tol, false);
  return false;
}

export function hitIn(vp: Viewport, nodeId: NodeId, lx: number, ly: number): NodeId | null {
  const node = docStore.doc.nodes[nodeId];
  if (!node) return null;
  // 裁剪：点不在内容区时子节点不参与命中
  const clipped = node.clip && (node.type === "frame" || node.type === "component" || node.type === "instance");
  const canHitChildren = !clipped || insideBox(node, lx, ly);
  if (canHitChildren) {
    for (let i = node.children.length - 1; i >= 0; i--) {
      const c = docStore.doc.nodes[node.children[i]];
      if (!c || !c.visible || c.locked) continue;
      if (c.type === "instance" && ui.instanceContext.at(-1) !== c.id) return c.id;
      const local = toLocal(c, lx, ly);
      const shapeHit = hitShapeAt(c, local.x, local.y, 5 / vp.zoom);
      if (shapeHit !== null) {
        if (shapeHit) return c.id;
        continue;
      }
      if (insideBox(c, local.x, local.y)) {
        return hitIn(vp, c.id, local.x, local.y) ?? c.id;
      }
    }
  }
  if (node.type === "instance" && ui.instanceContext.at(-1) === node.id) return node.id;
  return null;
}

export interface Hit {
  id: NodeId;
  pageId: NodeId;
  /** 命中非活动页（编辑模式下只切换活动页，不选子节点） */
  inactive: boolean;
}

export function hitTest(vp: Viewport, wx: number, wy: number): Hit | null {
  const editing = ui.mode === "edit";
  if (editing && ui.activePageId) {
    const page = docStore.doc.nodes[ui.activePageId];
    if (page) {
      const deep = hitIn(vp, page.id, wx - page.x, wy - page.y);
      if (deep) return { id: deep, pageId: page.id, inactive: false };
    }
  }
  for (const pageId of docStore.doc.rootIds) {
    const page = docStore.doc.nodes[pageId];
    if (!page) continue;
    if (wx < page.x || wy < page.y || wx > page.x + page.width || wy > page.y + page.height) continue;
    if (editing && pageId !== ui.activePageId) return { id: pageId, pageId, inactive: true };
    return { id: pageId, pageId, inactive: false };
  }
  return null;
}

export function pageAt(wx: number, wy: number): NodeId | null {
  for (const pageId of docStore.doc.rootIds) {
    const page = docStore.doc.nodes[pageId];
    if (page && wx >= page.x && wx <= page.x + page.width && wy >= page.y && wy <= page.y + page.height) return pageId;
  }
  return null;
}

/** 指针下的实例插槽（排除拖拽节点自身及其后代），用于拖入插槽。 */
export function slotUnder(vp: Viewport, wx: number, wy: number, dragged: readonly NodeId[]): NodeId | null {
  const pageId = pageAt(wx, wy);
  if (!pageId) return null;
  const blocked = new Set(dragged);
  const found: { id: NodeId | null; depth: number } = { id: null, depth: -1 };
  const visit = (id: NodeId, depth: number, insideBlocked: boolean) => {
    const node = docStore.doc.nodes[id];
    if (!node || !node.visible || node.locked) return;
    const isBlocked = insideBlocked || blocked.has(id);
    if (node.type === "slot" && !isBlocked && findOverrideOwner(docStore.doc, node.id)) {
      const r = worldRect(docStore.doc, node.id);
      if (r && wx >= r.x && wx <= r.x + r.width && wy >= r.y && wy <= r.y + r.height && depth > found.depth) {
        found.id = node.id;
        found.depth = depth;
      }
    }
    for (const childId of node.children) visit(childId, depth + 1, isBlocked);
  };
  visit(pageId, 0, false);
  return found.id;
}

