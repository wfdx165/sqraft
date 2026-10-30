/**
 * 选中量距：选中元素后，标出它与同父兄弟在上下左右四个方向上的最近间距。
 *
 * 与拖动时的参考线（`computeGuides`）共用 `GapMark` 数据结构与 `drawGuides` 绘制：
 * 拖动是"边拖边吸"，选中只是"读一下现有布局"，所以单独算，不去动拖动时的吸附逻辑。
 *
 * 多选时用整个选区包围盒参与计算；只有所有选中项同父时才算（跨层级比较没有意义）。
 */
import { unionRects, worldRect, type DocState, type NodeId, type Rect } from "@sqraft/core";
import type { GapMark } from "./guides";

export interface SelectionSpacingOptions {
  /** 当前缩放：间距太小（屏幕像素不足）时数字会挤在一起，直接不画 */
  zoom: number;
  /** 端点最小屏幕距离（默认 8px） */
  minScreenPx?: number;
}

export interface SpacingVisibility {
  editing: boolean;
  tool: string;
  /** 是否有进行中的手势/编辑态：拖动、框选、拖参考线、钢笔草稿、裁切、行内编辑、锚点编辑 */
  busy: boolean;
  selectionCount: number;
}

/** 只有空闲的编辑态 + 选择工具 + 有选区时才画量距。 */
export function showSelectionSpacing(state: SpacingVisibility): boolean {
  return state.editing && state.tool === "select" && !state.busy && state.selectionCount > 0;
}

/** 两个矩形在垂直方向上的重叠（> 0 才算"左右相邻"）。 */
function overlapY(a: Rect, b: Rect): number {
  return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
}

/** 两个矩形在水平方向上的重叠（> 0 才算"上下相邻"）。 */
function overlapX(a: Rect, b: Rect): number {
  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
}

/** 同一父级下、可见、且不在选区里的兄弟矩形。 */
function siblingRects(doc: DocState, parentId: NodeId, selected: ReadonlySet<NodeId>): Rect[] {
  const parent = doc.nodes[parentId];
  if (!parent) return [];
  const out: Rect[] = [];
  for (const id of parent.children) {
    if (selected.has(id)) continue;
    const sibling = doc.nodes[id];
    if (!sibling || sibling.visible === false) continue;
    const rect = worldRect(doc, id);
    if (rect) out.push(rect);
  }
  return out;
}

/** 用给定矩形和候选兄弟算四个方向的最近间距。 */
function gapsAgainst(rect: Rect, siblings: readonly Rect[], options: SelectionSpacingOptions): GapMark[] {
  const zoom = options.zoom;
  const minScreenPx = options.minScreenPx ?? 8;

  type Side = "left" | "right" | "top" | "bottom";
  const nearest = new Map<Side, { gap: number; mark: GapMark }>();
  const consider = (side: Side, gap: number, mark: GapMark): void => {
    if (gap <= 0) return;
    const previous = nearest.get(side);
    if (previous && previous.gap <= gap) return;
    nearest.set(side, { gap, mark });
  };

  for (const other of siblings) {
    // 左右：垂直方向要有重叠
    const vOverlap = overlapY(rect, other);
    if (vOverlap > 0) {
      const y = (Math.max(rect.y, other.y) + Math.min(rect.y + rect.height, other.y + other.height)) / 2;
      const leftGap = rect.x - (other.x + other.width);
      if (leftGap > 0) {
        consider("left", leftGap, {
          x1: other.x + other.width,
          y1: y,
          x2: rect.x,
          y2: y,
          value: Math.round(leftGap),
        });
      }
      const rightGap = other.x - (rect.x + rect.width);
      if (rightGap > 0) {
        consider("right", rightGap, {
          x1: rect.x + rect.width,
          y1: y,
          x2: other.x,
          y2: y,
          value: Math.round(rightGap),
        });
      }
    }

    // 上下：水平方向要有重叠
    const hOverlap = overlapX(rect, other);
    if (hOverlap > 0) {
      const x = (Math.max(rect.x, other.x) + Math.min(rect.x + rect.width, other.x + other.width)) / 2;
      const topGap = rect.y - (other.y + other.height);
      if (topGap > 0) {
        consider("top", topGap, {
          x1: x,
          y1: other.y + other.height,
          x2: x,
          y2: rect.y,
          value: Math.round(topGap),
        });
      }
      const bottomGap = other.y - (rect.y + rect.height);
      if (bottomGap > 0) {
        consider("bottom", bottomGap, {
          x1: x,
          y1: rect.y + rect.height,
          x2: x,
          y2: other.y,
          value: Math.round(bottomGap),
        });
      }
    }
  }

  return [...nearest.values()]
    .map((entry) => entry.mark)
    .filter(
      (mark) =>
        mark.value >= 1 &&
        Math.abs(mark.x2 - mark.x1) * zoom + Math.abs(mark.y2 - mark.y1) * zoom >= minScreenPx,
    );
}

/**
 * 选中元素与同父兄弟的间距标记：四个方向各取最近的一个，只保留真正有间隙的。
 *
 * 单选直接用节点矩形；多选用选区包围盒（要求所有选中项同父）。上下/左右用
 * 「另一轴上的重叠 > 0」判定相邻，避免把对角线上的兄弟也算进来；数值取整后
 * < 1 或端点屏幕距离不足 `minScreenPx` 的不返回。
 */
export function selectionSiblingGaps(
  doc: DocState,
  nodeIds: readonly NodeId[],
  options: SelectionSpacingOptions,
): GapMark[] {
  const nodes = nodeIds
    .map((id) => doc.nodes[id])
    .filter((node): node is NonNullable<typeof node> => Boolean(node) && node.type !== "page");
  if (nodes.length === 0) return [];
  // 选区里有隐藏节点：包围盒没有意义，整体不画（而不是丢掉它算一个偏小的框）
  if (nodes.some((node) => node.visible === false)) return [];

  const parentIds = new Set(nodes.map((node) => node.parentId));
  if (parentIds.size !== 1) return [];
  const parentId = nodes[0].parentId;
  if (!parentId) return [];

  const selected = new Set(nodes.map((node) => node.id));
  const rects = nodes.map((node) => worldRect(doc, node.id)).filter((rect): rect is Rect => Boolean(rect));
  if (rects.length !== nodes.length) return [];

  const rect = rects.length === 1 ? rects[0] : unionRects(rects);
  if (!rect) return [];
  return gapsAgainst(rect, siblingRects(doc, parentId, selected), options);
}
