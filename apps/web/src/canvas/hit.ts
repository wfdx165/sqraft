/**
 * 画布命中检测：页面、实例上下文、形状几何与插槽落点。
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

/**
 * 形状类节点的几何命中（路径 / 多边形 / 带 vector 的直线）。
 * 返回 null 表示不是形状类节点，交回通用包围盒规则。
 */
export function hitShapeAt(c: DocNode, lx: number, ly: number, tol: number): boolean | null {
  const isShape = c.type === "path" || c.type === "polygon" || (c.type === "line" && Boolean(c.vector));
  if (!isShape) return null;
  // 包围盒预检：细曲线 / 扁直线的空白区域不进入采样
  if (lx < c.x - tol || ly < c.y - tol || lx > c.x + c.width + tol || ly > c.y + c.height + tol) return false;
  const filled = Boolean(c.style.fill);
  // 既无填充也无描边的形状不可见，不参与命中（仍可从图层面板选中）；直线始终有默认描边
  if (!filled && !c.style.stroke && c.type !== "line") return false;
  if (c.type === "path" && c.vector) return hitVector(c.vector, lx - c.x, ly - c.y, tol, filled);
  if (c.type === "polygon") return hitPolygon(polygonPoints(c.sides, c.width, c.height), lx - c.x, ly - c.y, tol, filled);
  if (c.type === "line" && c.vector) return hitVector(c.vector, lx - c.x, ly - c.y, tol, false);
  return false;
}

export function hitIn(vp: Viewport, nodeId: NodeId, lx: number, ly: number): NodeId | null {
  const node = docStore.doc.nodes[nodeId];
  if (!node) return null;
  for (let i = node.children.length - 1; i >= 0; i--) {
    const c = docStore.doc.nodes[node.children[i]];
    if (!c || !c.visible) continue;
    // 未进入实例上下文时整体命中；进入后按内部图层命中
    if (c.type === "instance" && ui.instanceContext.at(-1) !== c.id) return c.id;
    // 形状按真实几何命中：细线/曲线的空白包围盒不抢点击
    const shapeHit = hitShapeAt(c, lx, ly, 5 / vp.zoom);
    if (shapeHit !== null) {
      if (shapeHit) return c.id;
      continue;
    }
    if (lx >= c.x && lx <= c.x + c.width && ly >= c.y && ly <= c.y + c.height) {
      return hitIn(vp, c.id, lx - c.x, ly - c.y) ?? c.id;
    }
  }
  // 在实例上下文内点到空白处：选中实例本身
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
  // 编辑模式先按活动页子节点的真实几何命中：形状可以越出页面，露在外面的部分也要能点中
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
    if (!node || !node.visible) return;
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
