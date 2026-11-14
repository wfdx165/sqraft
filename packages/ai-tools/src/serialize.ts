/** read_document / search_nodes 的序列化与作用域工具（纯函数，除 serializeNode 读 store.doc）。 */

import type { DocNode, DocState, DocStore, NodeId } from "@sqraft/core";
import { walkSubtree } from "@sqraft/core";

/** 单个节点的序列化投影（read_document 的节点行）。 */
export function serializeNode(store: DocStore, n: DocNode, depth: number): Record<string, unknown> {
  return {
    id: n.id,
    depth,
    type: n.type,
    name: n.name,
    parentId: n.parentId,
    children: n.children,
    x: n.x,
    y: n.y,
    w: n.width,
    h: n.height,
    text: n.text,
    rotation: n.rotation,
    opacity: n.opacity,
    visible: n.visible,
    locked: n.locked,
    clip: n.clip,
    style: n.style,
    ...(n.layout ? { layout: n.layout } : {}),
    ...(n.layoutSizingW ? { layoutSizingW: n.layoutSizingW } : {}),
    ...(n.layoutSizingH ? { layoutSizingH: n.layoutSizingH } : {}),
    ...(n.layoutAbsolute ? { layoutAbsolute: n.layoutAbsolute } : {}),
    ...(n.textAutoResize ? { textAutoResize: n.textAutoResize } : {}),
    ...(n.listType ? { listType: n.listType } : {}),
    ...(n.truncate ? { truncate: n.truncate } : {}),
    ...(n.type === "polygon" ? { sides: n.sides ?? 3 } : {}),
    ...(n.image ? { image: n.image } : {}),
    ...(n.vector ? { vector: n.vector } : {}),
    ...(n.componentId ? { componentId: n.componentId } : {}),
    ...(n.mainId ? { mainId: n.mainId } : {}),
    ...(n.propValues ? { propValues: n.propValues } : {}),
    ...(n.overrides ? { overrides: n.overrides } : {}),
    ...(n.slotFilled !== undefined ? { slotFilled: n.slotFilled } : {}),
    ...(n.propertyDefs ? { propertyDefs: n.propertyDefs } : {}),
    ...(n.scrollDirection ? { scrollDirection: n.scrollDirection } : {}),
    ...(n.interactions?.length
      ? {
          links: n.interactions.map((link) => ({
            id: link.id,
            action: link.action,
            target: link.targetId
              ? { pageId: link.targetId, name: store.doc.nodes[link.targetId]?.name ?? "" }
              : undefined,
            transition: link.transition.type,
            durationMs: link.transition.durationMs,
          })),
        }
      : {}),
  };
}

/** read_document 的作用域参数范围（越界夹紧，不报错）。 */
export const READ_DEPTH_DEFAULT = 1;
export const READ_DEPTH_MAX = 8;
export const READ_LIMIT_DEFAULT = 200;
export const READ_LIMIT_MAX = 1000;

export function clampIntArg(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} 必须是数字`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 先序收集作用域内的节点，depth 相对作用域根，数量到 limit 即停。 */
export function collectSlice(
  store: DocStore,
  rootId: NodeId,
  depth: number,
  limit: number,
): { nodes: Record<string, unknown>[]; truncated: boolean } {
  const nodes: Record<string, unknown>[] = [];
  const stack: Array<{ id: NodeId; depth: number }> = [{ id: rootId, depth: 0 }];
  while (stack.length > 0) {
    if (nodes.length >= limit) return { nodes, truncated: true };
    const cur = stack.pop()!;
    const node = store.doc.nodes[cur.id];
    if (!node) continue;
    nodes.push(serializeNode(store, node, cur.depth));
    if (cur.depth >= depth) continue;
    // 反向压栈，保证弹出顺序是先序
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      stack.push({ id: node.children[i], depth: cur.depth + 1 });
    }
  }
  return { nodes, truncated: false };
}

/** 节点所属页面；组件母版子树返回 null。 */
export function pageOfNode(doc: DocState, id: NodeId): NodeId | null {
  let cur: NodeId | null = id;
  while (cur) {
    const node: DocNode | undefined = doc.nodes[cur];
    if (!node) return null;
    if (node.type === "page") return node.id;
    cur = node.parentId;
  }
  return null;
}

export function countSubtree(store: DocStore, id: NodeId): number {
  let count = 0;
  walkSubtree(store.doc, id, () => {
    count += 1;
  });
  return count;
}

export type MatchField = "name" | "text" | "type" | "fillToken" | "strokeToken" | "componentId";

/** search_nodes 的命中摘要：超长截断到 80 个字符（按码点，不切坏表情）。 */
export function snippetOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  const chars = [...String(value)];
  return chars.length <= 80 ? chars.join("") : `${chars.slice(0, 79).join("")}…`;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 名称链：顶层归属（页面 / 组件母版）→ 父节点，不含自己。 */
export function pathOf(doc: DocState, id: NodeId): string[] {
  const names: string[] = [];
  let cur: NodeId | null = doc.nodes[id]?.parentId ?? null;
  while (cur) {
    const node: DocNode | undefined = doc.nodes[cur];
    if (!node) break;
    names.push(node.name);
    cur = node.parentId;
  }
  return names.reverse();
}

/** 读取 points：父容器坐标，x/y 必填，手柄缺省为 0。 */
