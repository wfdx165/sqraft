/**
 * 图层面板拖拽：把"拖到哪一行、放在上方/下方/里面"翻译成一次 `node.reparent`。
 *
 * 面板是**倒序**显示 children 的（最上层在最前），所以视觉上的"上方"对应
 * children 里更靠后的位置。同一父级内移动时，移除元素会让后面的索引左移一位。
 */
import type { DocState, NodeId } from "@sqraft/core";

export type DropPosition = "above" | "below" | "inside";

const CONTAINERS = new Set(["frame", "component", "group"]);

export function planLayerDrop(
  doc: DocState,
  dragId: NodeId,
  targetId: NodeId,
  position: DropPosition,
): { parentId: NodeId; index: number } | null {
  const dragged = doc.nodes[dragId];
  const target = doc.nodes[targetId];
  if (!dragged || !target || dragId === targetId) return null;
  if (dragged.type === "page" || target.type === "page") return null;
  if (insideInstance(doc, dragId) || insideInstance(doc, targetId)) return null;
  // 不能把节点拖进自己的子孙
  if (isDescendant(doc, targetId, dragId)) return null;

  if (position === "inside") {
    if (!CONTAINERS.has(target.type)) return null;
    return { parentId: target.id, index: target.children.length };
  }

  const parentId = target.parentId;
  const parent = parentId ? doc.nodes[parentId] : null;
  if (!parent || !parentId) return null;
  let index = parent.children.indexOf(targetId);
  if (position === "above") index += 1;
  // 同父级移动：先移除再插入，后面的索引会左移
  const oldIndex = parent.children.indexOf(dragId);
  if (dragged.parentId === parentId && oldIndex >= 0 && oldIndex < index) index -= 1;
  return { parentId, index };
}

/** targetId 是否在 ancestorId 的子树里。 */
function isDescendant(doc: DocState, targetId: NodeId, ancestorId: NodeId): boolean {
  let cur: NodeId | null = doc.nodes[targetId]?.parentId ?? null;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = doc.nodes[cur]?.parentId ?? null;
  }
  return false;
}

/** 实例内部结构由母版决定，不允许面板拖拽改顺序。 */
function insideInstance(doc: DocState, id: NodeId): boolean {
  // 实例根自己可以拖，只有"实例内部"才禁止
  let cur: NodeId | null = doc.nodes[id]?.parentId ?? null;
  while (cur) {
    const node = doc.nodes[cur];
    if (!node) return false;
    if (node.type === "instance") return true;
    cur = node.parentId;
  }
  return false;
}
