/**
 * 框选命中：
 * - 图层框选：只取当前层级、可见、未锁定的直接子节点，包围盒相交即选（不穿透容器）；
 * - 画板框选：跨多个画板、框中非活动画板或 Shift 追加画板时，选中与选框相交的可见未锁定画板，
 *   以便右键批量移入分组或批量拖动。
 */
import {
  isPageLockedByGroup,
  isPageVisibleByGroup,
  worldRect,
  type DocNode,
  type DocState,
  type NodeId,
  type Rect,
} from "@sqraft/core";

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 当前层级里与选框相交的节点（按绘制顺序，从下到上）。 */
export function marqueeHits(doc: DocState, levelId: NodeId | null, rect: Rect): NodeId[] {
  const level = levelId ? doc.nodes[levelId] : null;
  if (!level) return [];
  const out: NodeId[] = [];
  for (const id of level.children) {
    const node = doc.nodes[id];
    if (!node || !node.visible) continue;
    if (lockedChain(doc, id)) continue;
    const box = worldRect(doc, id);
    if (box && intersects(box, rect)) out.push(id);
  }
  return out;
}

/** 文档根节点里与选框相交的画板（可见、所属分组未隐藏且未锁定）。 */
export function marqueePageHits(doc: DocState, rect: Rect): NodeId[] {
  const out: NodeId[] = [];
  for (const id of doc.rootIds) {
    const node = doc.nodes[id];
    if (!node || node.type !== "page" || !node.visible) continue;
    if (!isPageVisibleByGroup(doc, node)) continue;
    if (node.locked || isPageLockedByGroup(doc, node)) continue;
    const box = worldRect(doc, id);
    if (box && intersects(box, rect)) out.push(id);
  }
  return out;
}

/**
 * 综合判定框选结果：
 * - 实例上下文内：仅框选当前实例的直接子节点；
 * - Shift 追加且已有画板选区：追加命中画板；
 * - 命中 ≥2 个画板，或命中非活动画板：选中画板（支持跨画板批量多选）；
 * - 否则优先选中活动画板内命中的图层；若没命中图层但命中了活动画板本身，则选中该画板。
 */
export function resolveMarqueeSelection(
  doc: DocState,
  activePageId: NodeId | null,
  instanceContext: readonly NodeId[],
  rect: Rect,
  opts: { additive: boolean; base: readonly NodeId[] },
): NodeId[] {
  const merge = (hits: NodeId[]) => (opts.additive ? [...new Set([...opts.base, ...hits])] : hits);
  if (instanceContext.length > 0) {
    return merge(marqueeHits(doc, instanceContext.at(-1)!, rect));
  }
  const pageHits = marqueePageHits(doc, rect);
  const baseArePages =
    opts.additive && opts.base.length > 0 && opts.base.every((id) => doc.nodes[id]?.type === "page");
  if (baseArePages) return merge(pageHits);

  if (pageHits.length > 1 || (pageHits.length === 1 && pageHits[0] !== activePageId)) {
    return merge(pageHits);
  }

  const childHits = marqueeHits(doc, activePageId, rect);
  if (childHits.length > 0) return merge(childHits);
  if (pageHits.length === 1) return merge(pageHits);
  return opts.additive ? [...opts.base] : [];
}

function lockedChain(doc: DocState, id: NodeId): boolean {
  let cur: DocNode | undefined = doc.nodes[id];
  while (cur) {
    if (cur.locked) return true;
    if (cur.type === "page" && isPageLockedByGroup(doc, cur)) return true;
    cur = cur.parentId ? doc.nodes[cur.parentId] : undefined;
  }
  return false;
}
