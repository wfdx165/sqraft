/**
 * 面向 agent 的自动布局推荐：写工具返回体里附 `layoutHints`。
 *
 * 和 diagnostics 分开：诊断是「必须修」，这里只是「可以换一种做法」——
 * 不阻塞、不回滚、不进 UI，也不改变文档。判断保持高置信度：同一个
 * frame/component 的全部子项（≥3）沿一条轴线等距排开、交叉轴对齐、且都在
 * 容器内。按 `suggested` 加上布局后，求解结果与当前摆放一致，不会把设计打乱。
 */

import type { DocNode, DocStore, NodeId, Padding } from "@sqraft/core";

/** 少于三个子项时更像随手摆的两块，不值得建议。 */
const MIN_CHILDREN = 3;
/** 交叉轴对齐容差（文档单位）：肉眼看起来在一条线上就算对齐。 */
const ALIGN_TOLERANCE = 1;
/** 间距允许的波动：绝对 2 或均值的 10%，两者取大。 */
const GAP_TOLERANCE = 2;
const GAP_TOLERANCE_RATIO = 0.1;
/** 子项允许溢出的容差：超出就说明这个容器本来不是它们的框。 */
const EDGE_TOLERANCE = 0.5;

/** 插画类节点：导入的 SVG 常是一列形状，给它们开布局只会打乱构图。 */
const ARTWORK_TYPES: ReadonlySet<string> = new Set(["path", "polygon"]);
/** 这些工具的产物不是 UI 结构，不给建议。 */
const SILENT_TOOLS: ReadonlySet<string> = new Set(["import_svg"]);

type Axis = "vertical" | "horizontal";

export interface LayoutHint {
  nodeId: NodeId;
  name: string;
  direction: Axis;
  children: number;
  /** 直接可以传给 `update_node` 的 `layout`：求解结果与当前摆放一致 */
  suggested: {
    direction: Axis;
    gap: number;
    padding: Padding;
    crossAlign: "start" | "center";
  };
  message: string;
  hint: string;
}

interface Arrangement {
  direction: Axis;
  gap: number;
  crossAlign: "start" | "center";
}

function spread(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 全部子项是否沿一条轴线等距排开、交叉轴对齐。文档顺序必须与视觉顺序一致。 */
function arrangementOf(kids: readonly DocNode[]): Arrangement | null {
  const directions: readonly Axis[] = ["vertical", "horizontal"];
  for (const direction of directions) {
    const pos: "x" | "y" = direction === "vertical" ? "y" : "x";
    const size: "width" | "height" = direction === "vertical" ? "height" : "width";
    const cross: "x" | "y" = direction === "vertical" ? "x" : "y";
    const crossSize: "width" | "height" = direction === "vertical" ? "width" : "height";

    const gaps: number[] = [];
    let ordered = true;
    for (let i = 1; i < kids.length; i++) {
      const gap = kids[i][pos] - (kids[i - 1][pos] + kids[i - 1][size]);
      if (kids[i][pos] < kids[i - 1][pos] || gap <= 0) {
        ordered = false;
        break;
      }
      gaps.push(gap);
    }
    if (!ordered) continue;

    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    if (spread(gaps) > Math.max(GAP_TOLERANCE, mean * GAP_TOLERANCE_RATIO)) continue;

    const starts = kids.map((kid) => kid[cross]);
    const centers = kids.map((kid) => kid[cross] + kid[crossSize] / 2);
    let crossAlign: Arrangement["crossAlign"] | null = null;
    if (spread(starts) <= ALIGN_TOLERANCE) crossAlign = "start";
    else if (spread(centers) <= ALIGN_TOLERANCE) crossAlign = "center";
    if (!crossAlign) continue;

    return { direction, gap: round(mean), crossAlign };
  }
  return null;
}

/** 判断一个容器是否值得建议；不值得返回 null。 */
export function layoutHintFor(store: DocStore, parentId: NodeId): LayoutHint | null {
  const parent = store.doc.nodes[parentId];
  if (!parent || (parent.type !== "frame" && parent.type !== "component")) return null;
  if (parent.layout || parent.width <= 0 || parent.height <= 0) return null;
  // hug 容器加上布局会按内容改尺寸，就不是「保持原样」了
  if (parent.layoutSizingW === "hug" || parent.layoutSizingH === "hug") return null;
  if (parent.children.length < MIN_CHILDREN) return null;

  const kids: DocNode[] = [];
  for (const id of parent.children) {
    const kid = store.doc.nodes[id];
    // 隐藏子项不参与排布；插画不是 UI 结构
    if (!kid || !kid.visible || ARTWORK_TYPES.has(kid.type)) return null;
    // fill 在布局里会改变尺寸：建议就不再是「视觉不变」
    if (kid.layoutSizingW === "fill" || kid.layoutSizingH === "fill") return null;
    kids.push(kid);
  }

  const arrangement = arrangementOf(kids);
  if (!arrangement) return null;

  const padding: Padding = {
    top: round(Math.min(...kids.map((kid) => kid.y))),
    left: round(Math.min(...kids.map((kid) => kid.x))),
    bottom: round(parent.height - Math.max(...kids.map((kid) => kid.y + kid.height))),
    right: round(parent.width - Math.max(...kids.map((kid) => kid.x + kid.width))),
  };
  if (
    padding.top < -EDGE_TOLERANCE ||
    padding.left < -EDGE_TOLERANCE ||
    padding.bottom < -EDGE_TOLERANCE ||
    padding.right < -EDGE_TOLERANCE
  ) {
    return null;
  }

  const shape = arrangement.direction === "vertical" ? "column" : "row";
  return {
    nodeId: parent.id,
    name: parent.name,
    direction: arrangement.direction,
    children: kids.length,
    suggested: {
      direction: arrangement.direction,
      gap: arrangement.gap,
      padding,
      crossAlign: arrangement.crossAlign,
    },
    message: `"${parent.name}" has ${kids.length} children in an evenly spaced ${shape} but no auto layout.`,
    hint: `Pass suggested to update_node({nodeId:"${parent.id}", layout: suggested}) to keep this exact arrangement and make it reflow when content changes.`,
  };
}

/**
 * 把建议并进写工具的返回体。
 *
 * 只在「容器本身也被这次调用改动」时提醒（新建/换父级/对齐都会改到父容器；
 * 单纯改子项文字不会），避免同一份手摆稿反复出现同一条建议。
 */
export function attachLayoutHints(
  store: DocStore,
  raw: string,
  changed: Set<NodeId>,
  toolName: string,
): string {
  if (SILENT_TOOLS.has(toolName)) return raw;

  const parents = new Set<NodeId>();
  for (const id of changed) {
    const parentId = store.doc.nodes[id]?.parentId;
    if (!parentId) continue;
    // arrange_nodes 只改子项坐标，但"刚对齐/分布过"正是最该换成布局的时刻
    if (changed.has(parentId) || toolName === "arrange_nodes") parents.add(parentId);
  }
  if (parents.size === 0) return raw;

  const hints: LayoutHint[] = [];
  for (const parentId of parents) {
    const hint = layoutHintFor(store, parentId);
    if (hint) hints.push(hint);
  }
  if (hints.length === 0) return raw;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  return JSON.stringify({ ...parsed, layoutHints: hints });
}
