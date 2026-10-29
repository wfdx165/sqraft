/**
 * 布局 pass：事务末尾找出受影响的自动布局容器，自底向上求解。
 * 只负责「算」，写回与撤销由命令层完成。
 */

import { solveLayout, type LayoutChildInput } from "./layout";
import type { DocNode, DocState, NodeId } from "./model";

/** 收集受影响节点自身及祖先链上的布局容器，按深度从深到浅排序。 */
export function collectLayoutContainers(state: DocState, changed: Iterable<NodeId>): NodeId[] {
  const depthOf = (id: NodeId): number => {
    let depth = 0;
    let cur = state.nodes[id]?.parentId;
    while (cur) {
      depth += 1;
      cur = state.nodes[cur]?.parentId ?? null;
    }
    return depth;
  };
  const containers = new Map<NodeId, number>();
  for (const id of changed) {
    let cur: DocNode | undefined = state.nodes[id];
    while (cur) {
      if (cur.layout) containers.set(cur.id, depthOf(cur.id));
      cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
    }
  }
  return [...containers.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** 容器当前内容区可用尺寸：hug 轴返回 undefined。 */
export function layoutAvail(node: DocNode): { availW: number | undefined; availH: number | undefined } {
  return {
    availW: (node.layoutSizingW ?? "fixed") === "hug" ? undefined : node.width,
    availH: (node.layoutSizingH ?? "fixed") === "hug" ? undefined : node.height,
  };
}

/** 由当前文档构造求解输入。 */
export function layoutChildren(state: DocState, container: DocNode): LayoutChildInput[] {
  const out: LayoutChildInput[] = [];
  for (const childId of container.children) {
    const child = state.nodes[childId];
    if (!child) continue;
    const autoResize = child.type === "text" ? (child.textAutoResize ?? "auto-width") : "fixed";
    out.push({
      id: child.id,
      x: child.x,
      y: child.y,
      width: child.width,
      height: child.height,
      sizingW: child.layoutSizingW ?? "fixed",
      sizingH: child.layoutSizingH ?? "fixed",
      minW: child.layoutMinW,
      maxW: child.layoutMaxW,
      minH: child.layoutMinH,
      maxH: child.layoutMaxH,
      absolute: child.layoutAbsolute,
      visible: child.visible,
      hugW: child.layoutSizingW === "hug" || autoResize === "auto-width",
      hugH: child.layoutSizingH === "hug" || autoResize === "auto-height",
    });
  }
  return out;
}

/** 求解一个容器：返回需要写回的几何与容器自身尺寸。 */
export function solveContainer(state: DocState, container: DocNode) {
  if (!container.layout) return null;
  const { availW, availH } = layoutAvail(container);
  const result = solveLayout(container.layout, layoutChildren(state, container), availW, availH);
  const hugW = (container.layoutSizingW ?? "fixed") === "hug";
  const hugH = (container.layoutSizingH ?? "fixed") === "hug";
  return {
    items: result.items,
    width: hugW ? result.contentWidth : container.width,
    height: hugH ? result.contentHeight : container.height,
  };
}
