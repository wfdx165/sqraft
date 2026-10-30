/**
 * 分组 / 解组（Figma 语义）。
 *
 * 组是"边界等于子节点并集"的轻量容器：不填充、不裁剪、不承载自动布局。
 * 展开成基础命令（create + reparent / reparent + delete），撤销与校验复用现有机制。
 */
import { createNode, worldRect, type DocNode, type DocState, type NodeId, type Rect } from "./model";
import type { Command } from "./store";
import { topLevelIds } from "./duplicate";
import { lockedChain } from "./arrange";

export interface GroupParams {
  nodeIds: NodeId[];
  /** 新分组的 id：命令必须确定性，id 在命令创建前分配 */
  groupId: NodeId;
  name?: string;
}

export function expandGroup(doc: DocState, params: GroupParams): Command[] {
  const ids = topLevelIds(doc, params.nodeIds).filter((id) => {
    const node = doc.nodes[id];
    return !!node && node.type !== "page" && !lockedChain(doc, id);
  });
  if (ids.length === 0) throw new Error("请选择要分组的节点");
  if (doc.nodes[params.groupId]) throw new Error(`节点 ${params.groupId} 已存在`);

  // 跨页面分组会把节点搬走，直接拒绝
  const pages = new Set(ids.map((id) => pageOf(doc, id)));
  if (pages.size > 1) throw new Error("分组要求同一页面");

  const boxes = new Map<NodeId, Rect>();
  for (const id of ids) {
    const box = worldRect(doc, id);
    if (!box) throw new Error(`节点 ${id} 不存在`);
    boxes.set(id, box);
  }
  const left = Math.min(...[...boxes.values()].map((b) => b.x));
  const top = Math.min(...[...boxes.values()].map((b) => b.y));
  const right = Math.max(...[...boxes.values()].map((b) => b.x + b.width));
  const bottom = Math.max(...[...boxes.values()].map((b) => b.y + b.height));

  // 目标父级：第一个节点的父级（跨父级选区会被提升到它下面，世界坐标不变）
  const first = doc.nodes[ids[0]];
  const parent = first.parentId ? doc.nodes[first.parentId] : null;
  if (!parent) throw new Error("页面与主组件都是根节点，不能分组");
  const parentWorld = worldRect(doc, parent.id);
  if (!parentWorld) throw new Error(`父节点 ${parent.id} 不存在`);

  // 插在选区里视觉最上层那个节点原来的位置
  const sameParent = ids.filter((id) => doc.nodes[id].parentId === parent.id);
  const index =
    sameParent.length > 0
      ? Math.max(...sameParent.map((id) => parent.children.indexOf(id))) + 1
      : parent.children.length;

  const group = createNode("group", {
    id: params.groupId,
    name: params.name ?? nextGroupName(doc),
    parentId: parent.id,
    x: left - parentWorld.x,
    y: top - parentWorld.y,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    clip: false,
    style: {},
  });

  const out: Command[] = [{ type: "node.create", params: { nodes: [group], parentId: parent.id, index } }];
  for (const id of ids) {
    const box = boxes.get(id)!;
    out.push({
      type: "node.reparent",
      params: {
        nodeId: id,
        parentId: group.id,
        // 世界坐标 - 组的世界原点 = 组内本地坐标
        x: box.x - left,
        y: box.y - top,
      },
    });
  }
  return out;
}

/** 解组：子节点提升到组的父级、保持世界坐标、插回组原来的位置。 */
export function expandUngroup(doc: DocState, params: { nodeId: NodeId }): Command[] {
  const group = doc.nodes[params.nodeId];
  if (!group || group.type !== "group") throw new Error("只有分组可以解组");
  const parent = group.parentId ? doc.nodes[group.parentId] : null;
  if (!parent) throw new Error("根级分组不能解组");
  const parentWorld = worldRect(doc, parent.id);
  if (!parentWorld) throw new Error(`父节点 ${parent.id} 不存在`);
  const index = parent.children.indexOf(group.id);

  const out: Command[] = [];
  group.children.forEach((childId, offset) => {
    const box = worldRect(doc, childId);
    if (!box) return;
    out.push({
      type: "node.reparent",
      params: {
        nodeId: childId,
        parentId: parent.id,
        index: index + offset,
        x: box.x - parentWorld.x,
        y: box.y - parentWorld.y,
      },
    });
  });
  out.push({ type: "node.delete", params: { nodeId: group.id } });
  return out;
}

/** 节点所属页面（沿父链上溯）。 */
function pageOf(doc: DocState, id: NodeId): NodeId | null {
  let cur: NodeId | null = id;
  while (cur) {
    const node: DocNode | undefined = doc.nodes[cur];
    if (!node) return null;
    if (node.type === "page") return node.id;
    cur = node.parentId;
  }
  return null;
}

/** 「分组 N」：取现有分组数量推导，不依赖时间/随机。 */
function nextGroupName(doc: DocState): string {
  const used = new Set(
    Object.values(doc.nodes)
      .filter((node: DocNode) => node.type === "group")
      .map((node) => node.name),
  );
  let i = 1;
  while (used.has(`分组 ${i}`)) i += 1;
  return `分组 ${i}`;
}
