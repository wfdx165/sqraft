/**
 * 左栏图层树的展开态判定（纯函数，便于单测）。
 *
 * 默认态：实例折叠（内部图层通常很多），其它容器展开；用户点过的行以
 * `ui.expandedLayers` 里的记录为准。锁定的容器不展开——它的整棵子树本来就不显示。
 */
import type { DocNode, NodeId } from "@sqraft/core";

/** 容器行是否展开。 */
export function isLayerExpanded(node: DocNode, expanded: Record<NodeId, boolean>): boolean {
  return expanded[node.id] ?? node.type !== "instance";
}

/** 可折叠 = 有子元素且未锁定。 */
export function canExpand(node: DocNode): boolean {
  return node.children.length > 0 && !node.locked;
}
