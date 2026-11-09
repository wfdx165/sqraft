/**
 * 拖入自动布局容器的让位预览：
 * - 用求解器在插入点塞入等尺寸的“幽灵”子项，算出兄弟的新位置；
 * - hug 容器同步得到新尺寸；
 * - 120ms ease-out 过渡。
 * 纯 UI 预览，不改文档、不进撤销。
 */
import {
  layoutAvail,
  layoutChildren,
  resolveNumericLayout,
  solveLayout,
  worldRect,
  type LayoutChildInput,
  type NodeId,
} from "@sqraft/core";
import { docStore } from "../store";

export interface PreviewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InsertTransition {
  from: Map<NodeId, PreviewBox>;
  to: Map<NodeId, PreviewBox>;
  start: number;
  boxes: Map<NodeId, PreviewBox>;
}

export const PREVIEW_EASE_MS = 120;

/** 插入让位后的目标几何（父局部坐标）；容器没有布局或没有可插入根时返回 null。 */
export function buildInsertPreview(
  containerId: NodeId,
  index: number,
  roots: readonly NodeId[],
): Map<NodeId, PreviewBox> | null {
  const doc = docStore.doc;
  const container = doc.nodes[containerId];
  if (!container?.layout) return null;
  const moving = new Set(roots);
  // 同父重排时移动根要先离开原槽位，再按插入索引重新占位
  const items = layoutChildren(doc, container).filter((item) => !moving.has(item.id));
  const at = Math.max(0, Math.min(index, items.length));
  const ghosts: LayoutChildInput[] = [];
  for (const id of roots) {
    const r = worldRect(doc, id);
    if (!r) continue;
    ghosts.push({
      id,
      x: 0,
      y: 0,
      width: r.width,
      height: r.height,
      sizingW: "fixed",
      sizingH: "fixed",
      absolute: false,
      visible: true,
      hugW: false,
      hugH: false,
    });
  }
  if (ghosts.length === 0) return null;
  items.splice(at, 0, ...ghosts);
  const { availW, availH } = layoutAvail(container);
  // 与布局 pass 保持一致：预览也要用解析后的 gap / padding
  const layout = resolveNumericLayout(doc, container.layout);
  const solved = solveLayout(layout, items, availW, availH);

  const boxes = new Map<NodeId, PreviewBox>();
  for (const item of solved.items) {
    if (moving.has(item.id)) continue;
    const node = doc.nodes[item.id];
    if (!node) continue;
    if (item.x !== node.x || item.y !== node.y || item.width !== node.width || item.height !== node.height) {
      boxes.set(item.id, { x: item.x, y: item.y, width: item.width, height: item.height });
    }
  }

  // hug 容器：尺寸一起预览，避免子项溢出
  const hugW = (container.layoutSizingW ?? "fixed") === "hug";
  const hugH = (container.layoutSizingH ?? "fixed") === "hug";
  if (hugW || hugH) {
    const width = hugW ? solved.contentWidth : container.width;
    const height = hugH ? solved.contentHeight : container.height;
    if (Math.abs(width - container.width) > 0.001 || Math.abs(height - container.height) > 0.001) {
      boxes.set(containerId, { x: container.x, y: container.y, width, height });
    }
  }
  return boxes;
}

function naturalBox(id: NodeId): PreviewBox | null {
  const node = docStore.doc.nodes[id];
  return node ? { x: node.x, y: node.y, width: node.width, height: node.height } : null;
}

/**
 * 开始/重定向一次过渡：保留当前插值结果作为新起点；
 * 不再需要覆盖的节点缓动回自然位置（离开容器时不瞬移）。
 */
export function retargetInsertPreview(
  prev: Map<NodeId, PreviewBox> | null,
  target: Map<NodeId, PreviewBox>,
  now: number,
): InsertTransition {
  const from = new Map(prev ?? []);
  const to = new Map(target);
  for (const id of to.keys()) {
    if (!from.has(id)) {
      const natural = naturalBox(id);
      if (natural) from.set(id, natural);
    }
  }
  for (const id of [...from.keys()]) {
    if (to.has(id)) continue;
    const natural = naturalBox(id);
    if (natural) to.set(id, natural);
    else from.delete(id);
  }
  return { from, to, start: now, boxes: new Map(from) };
}

/** 推进过渡；`done` 为 true 表示已到达目标，可以停止重绘。 */
export function tickInsertPreview(state: InsertTransition, now: number): { boxes: Map<NodeId, PreviewBox>; done: boolean } {
  const t = Math.min(1, (now - state.start) / PREVIEW_EASE_MS);
  if (t >= 1) {
    state.boxes = new Map(state.to);
    return { boxes: state.boxes, done: true };
  }
  const e = 1 - Math.pow(1 - t, 3);
  const boxes = new Map<NodeId, PreviewBox>();
  for (const [id, to] of state.to) {
    const from = state.from.get(id) ?? to;
    boxes.set(id, {
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e,
      width: from.width + (to.width - from.width) * e,
      height: from.height + (to.height - from.height) * e,
    });
  }
  state.boxes = boxes;
  return { boxes, done: false };
}

/** 过渡是否已无任何覆盖（用于动画结束后回收状态）。 */
export function isEmptyTransition(state: InsertTransition): boolean {
  return state.to.size === 0;
}
