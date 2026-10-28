/**
 * 自动布局求解器：纯函数，两遍法（测量 + 排布）。
 * v1 骨架实现：方向/gap/padding/对齐/hug-fill-fixed。
 * wrap 与 min/max 为 M2 攻坚项（见 docs/roadmap.md），接口已预留。
 */

import type { LayoutSpec, NodeId } from "./model";

export interface LayoutChildInput {
  id: NodeId;
  width: number;
  height: number;
  sizingW: "fixed" | "hug" | "fill";
  sizingH: "fixed" | "hug" | "fill";
  minW?: number;
  maxW?: number;
  minH?: number;
  maxH?: number;
  /** 绝对定位子项不参与求解 */
  absolute?: boolean;
}

export interface LayoutResult {
  id: NodeId;
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (v: number, min?: number, max?: number): number => {
  let out = v;
  if (min !== undefined) out = Math.max(out, min);
  if (max !== undefined) out = Math.min(out, max);
  return out;
};

/**
 * 计算容器内容区内各子节点的位置与尺寸。
 * @param availW/availH 容器内容区尺寸（已扣除 padding）
 */
export function solveLayout(
  spec: LayoutSpec,
  children: LayoutChildInput[],
  availW: number,
  availH: number,
): LayoutResult[] {
  const participating = children.filter((c) => !c.absolute);
  const absolute = children.filter((c) => c.absolute);
  const horizontal = spec.direction === "horizontal";
  const mainAvail = horizontal ? availW : availH;
  const crossAvail = horizontal ? availH : availW;
  const mainSize = (c: LayoutChildInput) => (horizontal ? c.width : c.height);
  const crossSize = (c: LayoutChildInput) => (horizontal ? c.height : c.width);

  // 第一遍：确定固定/撑开尺寸，收集 fill 项
  const sizes = new Map<NodeId, { main: number; cross: number }>();
  let usedMain = 0;
  const fills: LayoutChildInput[] = [];
  for (const c of participating) {
    const mainSizing = horizontal ? c.sizingW : c.sizingH;
    const crossSizing = horizontal ? c.sizingH : c.sizingW;
    if (mainSizing === "fill") {
      fills.push(c);
      sizes.set(c.id, { main: mainSize(c), cross: crossSize(c) });
      usedMain += mainSize(c);
    } else {
      const main = clamp(mainSize(c), horizontal ? c.minW : c.minH, horizontal ? c.maxW : c.maxH);
      sizes.set(c.id, { main, cross: clamp(crossSize(c), crossSizing === "fill" ? undefined : (horizontal ? c.minH : c.minW), horizontal ? c.maxH : c.maxW) });
      usedMain += main;
    }
  }
  usedMain += spec.gap * Math.max(0, participating.length - 1);

  // 主轴 fill 分配
  const free = mainAvail - usedMain;
  if (fills.length > 0 && free > 0) {
    const each = free / fills.length;
    for (const c of fills) {
      const s = sizes.get(c.id)!;
      s.main = clamp(s.main + each, horizontal ? c.minW : c.minH, horizontal ? c.maxW : c.maxH);
    }
  }

  // 第二遍：主轴排布
  const totalMain = participating.reduce((acc, c) => acc + sizes.get(c.id)!.main, 0) + spec.gap * Math.max(0, participating.length - 1);
  let cursor = 0;
  if (spec.mainAlign === "center") cursor = (mainAvail - totalMain) / 2;
  else if (spec.mainAlign === "end") cursor = mainAvail - totalMain;
  const gapExtra =
    spec.mainAlign === "space-between" && participating.length > 1
      ? (mainAvail - participating.reduce((a, c) => a + sizes.get(c.id)!.main, 0)) / (participating.length - 1)
      : spec.gap;

  const results: LayoutResult[] = [];
  for (const c of participating) {
    const s = sizes.get(c.id)!;
    let cross = s.cross;
    if (spec.crossAlign === "stretch") {
      cross = crossAvail;
      const crossSizing = horizontal ? c.sizingH : c.sizingW;
      if (crossSizing === "fixed") cross = clamp(crossSize(c), horizontal ? c.minH : c.minW, horizontal ? c.maxH : c.maxW);
    }
    let crossPos = 0;
    if (spec.crossAlign === "center") crossPos = (crossAvail - cross) / 2;
    else if (spec.crossAlign === "end") crossPos = crossAvail - cross;

    results.push({
      id: c.id,
      x: horizontal ? cursor : crossPos,
      y: horizontal ? crossPos : cursor,
      width: horizontal ? s.main : cross,
      height: horizontal ? cross : s.main,
    });
    cursor += s.main + gapExtra;
  }

  // 绝对定位子项按自身坐标原样保留
  for (const c of absolute) {
    results.push({ id: c.id, x: c.width >= 0 ? (c as LayoutChildInput & { x?: number }).x ?? 0 : 0, y: 0, width: c.width, height: c.height });
  }
  return results;
}
