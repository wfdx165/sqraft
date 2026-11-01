/**
 * 排列：层级顺序（z-order）与（后续的）对齐/分布。
 *
 * 放在 core 而不是 UI，是因为顺序语义与"多选保持相对顺序""越界幂等"这些规则
 * 必须能被测试覆盖，且 agent 工具要和 UI 走同一条路径。
 */
import { worldRect, type DocNode, type DocState, type NodeId, type Rect } from "./model";
import type { Command } from "./store";
import { resolveNumericLayout } from "./token-resolve";

export type ReorderAction = "forward" | "backward" | "front" | "back";

export interface ReorderParams {
  nodeIds: NodeId[];
  action: ReorderAction;
}

/**
 * 展开成 `node.reparent`：只改同一父级内的顺序，不换父级。
 *
 * - 页面、实例内部节点不参与（实例结构由母版决定）；
 * - 多选时保持相对顺序，整块移动；
 * - 已经在顶/底时展开为空命令列表，`apply` 不会留下空撤销记录。
 */
export function expandReorder(doc: DocState, params: ReorderParams): Command[] {
  const groups = new Map<NodeId, Set<NodeId>>();
  for (const id of params.nodeIds) {
    const node = doc.nodes[id];
    if (!node || !node.parentId || node.type === "page") continue;
    const parent = doc.nodes[node.parentId];
    if (!parent) continue;
    if (hasInstanceAncestor(doc, node.parentId)) continue;
    const group = groups.get(parent.id) ?? new Set<NodeId>();
    group.add(id);
    groups.set(parent.id, group);
  }

  const out: Command[] = [];
  for (const [parentId, selected] of groups) {
    const parent = doc.nodes[parentId];
    if (!parent) continue;
    const desired = reorderChildren(parent.children, selected, params.action);
    out.push(...movesToCommands(parentId, parent.children, desired));
  }
  return out;
}

/** 给定当前顺序与选中集合，算出目标顺序。 */
export function reorderChildren(
  children: readonly NodeId[],
  selected: ReadonlySet<NodeId>,
  action: ReorderAction,
): NodeId[] {
  const out = [...children];
  if (action === "front") {
    return [...out.filter((id) => !selected.has(id)), ...out.filter((id) => selected.has(id))];
  }
  if (action === "back") {
    return [...out.filter((id) => selected.has(id)), ...out.filter((id) => !selected.has(id))];
  }
  const step = action === "forward" ? 1 : -1;
  // 往上移动时从最上层开始处理，选中的兄弟才不会互相顶掉
  const order = action === "forward" ? out.map((_, i) => i).reverse() : out.map((_, i) => i);
  for (const i of order) {
    if (!selected.has(out[i])) continue;
    const j = i + step;
    if (j < 0 || j >= out.length) continue;
    if (selected.has(out[j])) continue;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 把"目标顺序"翻译成最少的 reparent：从低位到高位逐个归位。 */
function movesToCommands(parentId: NodeId, current: readonly NodeId[], desired: readonly NodeId[]): Command[] {
  const out: Command[] = [];
  const working = [...current];
  for (let i = 0; i < desired.length; i += 1) {
    if (working[i] === desired[i]) continue;
    const nodeId = desired[i];
    out.push({ type: "node.reparent", params: { nodeId, parentId, index: i } });
    working.splice(working.indexOf(nodeId), 1);
    working.splice(i, 0, nodeId);
  }
  return out;
}

function hasInstanceAncestor(doc: DocState, nodeId: NodeId): boolean {
  let cur: NodeId | null = nodeId;
  while (cur) {
    const node: DocNode | undefined = doc.nodes[cur];
    if (!node) return false;
    if (node.type === "instance") return true;
    cur = node.parentId;
  }
  return false;
}

/* ---------- 对齐与分布 ---------- */

export type AlignEdge = "left" | "h-center" | "right" | "top" | "v-center" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";

export interface AlignParams {
  nodeIds: NodeId[];
  align: AlignEdge;
}

export interface DistributeParams {
  nodeIds: NodeId[];
  axis: DistributeAxis;
}

/**
 * 对齐：单选对齐到父容器内容区（有自动布局时扣掉内边距），多选对齐到选区包围盒。
 * 只改 x/y（世界坐标增量 = 本地坐标增量，包围盒忽略旋转）。
 */
export function expandAlign(doc: DocState, params: AlignParams): Command[] {
  const ids = movableIds(doc, params.nodeIds);
  if (ids.length === 0) return [];
  assertNoLayoutChildren(doc, ids);

  const boxes = ids.map((id) => worldRect(doc, id)!);
  const target = ids.length === 1 ? parentContentBox(doc, ids[0]) : unionBox(boxes);
  if (!target) return [];

  const out: Command[] = [];
  ids.forEach((id, i) => {
    const box = boxes[i];
    const dx = deltaX(box, target, params.align);
    const dy = deltaY(box, target, params.align);
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;
    const node = doc.nodes[id];
    out.push({ type: "node.update", params: { nodeId: id, patch: { x: node.x + dx, y: node.y + dy } } });
  });
  return out;
}

/** 分布：至少 3 个，按包围盒等间距，两端节点不动。 */
export function expandDistribute(doc: DocState, params: DistributeParams): Command[] {
  const ids = movableIds(doc, params.nodeIds);
  if (ids.length < 3) throw new Error("分布至少需要 3 个节点");
  assertNoLayoutChildren(doc, ids);

  const horizontal = params.axis === "horizontal";
  const entries = ids
    .map((id) => ({ id, box: worldRect(doc, id)! }))
    .sort((a, b) => (horizontal ? a.box.x - b.box.x : a.box.y - b.box.y));

  const first = entries[0].box;
  const last = entries[entries.length - 1].box;
  const span = horizontal ? last.x + last.width - first.x : last.y + last.height - first.y;
  const occupied = entries.reduce((sum, e) => sum + (horizontal ? e.box.width : e.box.height), 0);
  const gap = (span - occupied) / (entries.length - 1);

  const out: Command[] = [];
  let cursor = horizontal ? first.x : first.y;
  for (const entry of entries) {
    const size = horizontal ? entry.box.width : entry.box.height;
    const delta = cursor - (horizontal ? entry.box.x : entry.box.y);
    if (Math.abs(delta) > 0.001) {
      const node = doc.nodes[entry.id];
      out.push({
        type: "node.update",
        params: { nodeId: entry.id, patch: horizontal ? { x: node.x + delta } : { y: node.y + delta } },
      });
    }
    cursor += size + gap;
  }
  return out;
}

/**
 * 可参与排列/缩放/旋转的节点：存在、不是页面、有父级、不在锁定链上。
 *
 * 锁定过滤放在这里而不是各调用方：agent 工具绕不过 UI 的过滤，
 * core 静默跳过锁定项，比在 validateLocks 里抛异常更符合"一次调用不该整体失败"。
 */
export function movableIds(doc: DocState, ids: readonly NodeId[]): NodeId[] {
  const seen = new Set<NodeId>();
  const out: NodeId[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = doc.nodes[id];
    if (!node || node.type === "page" || !node.parentId) continue;
    if (lockedChain(doc, id)) continue;
    out.push(id);
  }
  return out;
}

/** 自身或祖先被锁定。 */
export function lockedChain(doc: DocState, id: NodeId): boolean {
  let cur: NodeId | null = id;
  while (cur) {
    const node: DocNode | undefined = doc.nodes[cur];
    if (!node) return false;
    if (node.locked) return true;
    cur = node.parentId;
  }
  return false;
}

/** 自动布局子项的位置由布局求解器决定，手改坐标会立刻被覆盖。 */
function assertNoLayoutChildren(doc: DocState, ids: readonly NodeId[]): void {
  for (const id of ids) {
    const node = doc.nodes[id];
    const parent = node.parentId ? doc.nodes[node.parentId] : null;
    if (parent?.layout && !node.layoutAbsolute) {
      throw new Error("自动布局子项不能对齐或分布：位置由布局决定");
    }
  }
}

function parentContentBox(doc: DocState, id: NodeId): Rect | null {
  const node = doc.nodes[id];
  const parent = node.parentId ? doc.nodes[node.parentId] : null;
  if (!parent) return null;
  const box = worldRect(doc, parent.id);
  if (!box) return null;
  const pad = parent.layout ? resolveNumericLayout(doc, parent.layout).padding : undefined;
  if (!pad) return box;
  return {
    x: box.x + pad.left,
    y: box.y + pad.top,
    width: Math.max(1, box.width - pad.left - pad.right),
    height: Math.max(1, box.height - pad.top - pad.bottom),
  };
}

function unionBox(boxes: readonly Rect[]): Rect {
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function deltaX(box: Rect, target: Rect, align: AlignEdge): number {
  switch (align) {
    case "left":
      return target.x - box.x;
    case "h-center":
      return target.x + target.width / 2 - (box.x + box.width / 2);
    case "right":
      return target.x + target.width - (box.x + box.width);
    default:
      return 0;
  }
}

function deltaY(box: Rect, target: Rect, align: AlignEdge): number {
  switch (align) {
    case "top":
      return target.y - box.y;
    case "v-center":
      return target.y + target.height / 2 - (box.y + box.height / 2);
    case "bottom":
      return target.y + target.height - (box.y + box.height);
    default:
      return 0;
  }
}
