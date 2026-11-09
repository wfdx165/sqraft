/**
 * 拖拽落点（换父级）判定：
 * - 指针下最深的可接收子节点的容器（画板 / 组件 / 页面根）；
 * - 合法性规则：实例子树、组件结构、主组件页面顶层、环。
 * 纯查询，不改文档；新建节点的容器判定仍走 `layout-drag.containerAt`
 * （新建允许直接落进组件，拖拽不允许）。
 */
import { worldRect, type DocNode, type NodeId } from "@sqraft/core";
import { docStore } from "../store";
import { pageAt } from "./hit";

/** 一次拖拽的落点：画板/组件，或页面根。 */
export interface DropTarget {
  kind: "container" | "page";
  id: NodeId;
  /** 落点所在的页面（跨页时用于松手后切换活动页）。 */
  pageId: NodeId;
}

/** 节点所在页面（沿父链上溯到根）。 */
export function pageAncestorOf(id: NodeId): NodeId | null {
  let cur: DocNode | undefined = docStore.doc.nodes[id];
  while (cur) {
    if (cur.type === "page") return cur.id;
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  return null;
}

/** 最近的实例祖先（不含自身）。 */
export function instanceAncestorOf(id: NodeId): NodeId | null {
  let cur: NodeId | null = docStore.doc.nodes[id]?.parentId ?? null;
  while (cur) {
    const parent: DocNode | undefined = docStore.doc.nodes[cur];
    if (!parent) return null;
    if (parent.type === "instance") return parent.id;
    cur = parent.parentId ?? null;
  }
  return null;
}

/** 自身或祖先里的最近组件（含自身）。 */
export function componentOwnerOf(id: NodeId): NodeId | null {
  let cur: DocNode | undefined = docStore.doc.nodes[id];
  while (cur) {
    if (cur.type === "component") return cur.id;
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  return null;
}

/** `id` 是否等于 `ancestorId` 或在其子树里。 */
export function isSelfOrDescendant(id: NodeId, ancestorId: NodeId): boolean {
  let cur: DocNode | undefined = docStore.doc.nodes[id];
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  return false;
}

/**
 * 指针下的落点：页面内最深的画板/组件；指针在页面空白处则落到页面根；
 * 指针不在任何页面里返回 null（页面外不换父级）。
 * 跳过隐藏、锁定、实例，以及被拖节点自身的子树（避免移进自己的后代）。
 */
export function dropTargetAt(wx: number, wy: number, dragged: readonly NodeId[]): DropTarget | null {
  const pageId = pageAt(wx, wy);
  if (!pageId) return null;
  const blocked = new Set(dragged);
  let found: DocNode | null = null;
  const visit = (id: NodeId): void => {
    const parent = docStore.doc.nodes[id];
    if (!parent) return;
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const child = docStore.doc.nodes[parent.children[i]];
      if (!child || !child.visible || child.locked) continue;
      if (blocked.has(child.id)) continue;
      // 实例整体不参与（子树内部不换父级）；分组/普通节点不是可容纳容器
      if (child.type !== "frame" && child.type !== "component") continue;
      const r = worldRect(docStore.doc, child.id);
      if (r && wx >= r.x && wx <= r.x + r.width && wy >= r.y && wy <= r.y + r.height) {
        found = child;
        visit(child.id);
        return;
      }
    }
  };
  visit(pageId);
  if (!found) return { kind: "page", id: pageId, pageId };
  return { kind: "container", id: (found as DocNode).id, pageId };
}

/**
 * 单个节点能否落到目标里：
 * - 页面、根节点不换父级（主组件是文档根节点，永远走这一条）；
 * - 实例子树内部的节点一律不换父级（只能改覆盖字段 / 填插槽）；
 * - 组件的子节点只能在组件子树内移动，外部节点也不能拖进组件；
 * - 目标不能是节点自身或后代（遍历已过滤，这里再兜一层）。
 */
export function dropAllowed(nodeId: NodeId, target: DropTarget): boolean {
  const node = docStore.doc.nodes[nodeId];
  if (!node || !node.parentId) return false;
  if (node.type === "page") return false;
  if (instanceAncestorOf(nodeId)) return false;
  if (isSelfOrDescendant(target.id, nodeId)) return false;

  const owner = componentOwnerOf(nodeId);
  const targetOwner = componentOwnerOf(target.id);

  if (owner) {
    // 组件子节点：只能在同一个组件子树内换父级
    return targetOwner === owner;
  }
  // 普通节点：不能拖进组件（组件结构只能经「选区创建组件」与实例同步变更）
  return !targetOwner;
}
