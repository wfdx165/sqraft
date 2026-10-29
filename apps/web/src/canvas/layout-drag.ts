/**
 * 画布上的布局拖拽：
 * - 指针下的容器（用于把新节点建到画板里）；
 * - 自动布局容器内的重排序位置与插入指示线。
 */
import { worldRect, type DocNode, type NodeId } from "@sqraft/core";
import { docStore } from "../store";
import type { GuideLine } from "./guides";
import { pageAt } from "./hit";

/** 自动布局父容器（没有则 null）。 */
export function layoutParentOf(id: NodeId): DocNode | null {
  const node = docStore.doc.nodes[id];
  const parent = node?.parentId ? docStore.doc.nodes[node.parentId] : null;
  return parent?.layout ? parent : null;
}

/** 指针在父容器主轴上的投影（世界坐标）。 */
function projection(parent: DocNode, wx: number, wy: number): number {
  const angle = ((parent.rotation || 0) * Math.PI) / 180;
  const horizontal = parent.layout?.direction === "horizontal";
  const axisX = horizontal ? Math.cos(angle) : -Math.sin(angle);
  const axisY = horizontal ? Math.sin(angle) : Math.cos(angle);
  return wx * axisX + wy * axisY;
}

/** 插入位置：父容器里（可见、非绝对定位）投影小于指针的兄弟数量。 */
export function reorderIndexAt(parentId: NodeId, wx: number, wy: number, ignore: readonly NodeId[]): number {
  const parent = docStore.doc.nodes[parentId];
  if (!parent?.layout) return -1;
  const pointer = projection(parent, wx, wy);
  const skip = new Set(ignore);
  let index = 0;
  for (const childId of parent.children) {
    if (skip.has(childId)) continue;
    const child = docStore.doc.nodes[childId];
    if (!child || !child.visible || child.layoutAbsolute) continue;
    const r = worldRect(docStore.doc, childId);
    if (!r) continue;
    if (projection(parent, r.x + r.width / 2, r.y + r.height / 2) < pointer) index += 1;
  }
  return index;
}

/** 重排序的插入指示线（世界坐标）。 */
export function reorderGuide(parentId: NodeId, wx: number, wy: number): GuideLine[] {
  const parent = docStore.doc.nodes[parentId];
  const r = parent ? worldRect(docStore.doc, parentId) : null;
  if (!parent?.layout || !r) return [];
  return parent.layout.direction === "horizontal"
    ? [{ x1: wx, y1: r.y, x2: wx, y2: r.y + r.height }]
    : [{ x1: r.x, y1: wy, x2: r.x + r.width, y2: wy }];
}

/** 指针下最深的可容纳子节点的容器（frame/component）；实例内部不建游离节点。 */
export function containerAt(wx: number, wy: number): DocNode | null {
  const pageId = pageAt(wx, wy);
  if (!pageId) return null;
  let found: DocNode | null = null;
  const visit = (id: NodeId) => {
    const parent = docStore.doc.nodes[id];
    if (!parent) return;
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const child = docStore.doc.nodes[parent.children[i]];
      if (!child || !child.visible || child.locked) continue;
      if (child.type !== "frame" && child.type !== "component" && child.type !== "instance") continue;
      if (child.type === "instance") continue;
      const r = worldRect(docStore.doc, child.id);
      if (r && wx >= r.x && wx <= r.x + r.width && wy >= r.y && wy <= r.y + r.height) {
        found = child;
        visit(child.id);
        return;
      }
    }
  };
  visit(pageId);
  return found;
}
