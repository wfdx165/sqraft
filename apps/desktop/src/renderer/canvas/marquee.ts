/**
 * 框选命中：只取当前层级、可见、未锁定的直接子节点，包围盒**相交**即选。
 * 不穿透容器——框住一张卡片不会连带选中里面的文字（与 Figma 一致）。
 */
import { worldRect, type DocNode, type DocState, type NodeId, type Rect } from "@sqraft/core";

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

function lockedChain(doc: DocState, id: NodeId): boolean {
  let cur: DocNode | undefined = doc.nodes[id];
  while (cur) {
    if (cur.locked) return true;
    cur = cur.parentId ? doc.nodes[cur.parentId] : undefined;
  }
  return false;
}
