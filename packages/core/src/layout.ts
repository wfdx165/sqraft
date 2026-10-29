/**
 * 自动布局求解器：纯函数。
 * 输入容器内容区可用尺寸（border box，未扣 padding 之前），输出子项几何。
 * availW / availH 为 undefined 表示该轴为 hug：不分配填充空间，只报告内容尺寸。
 */

import type { LayoutSizing, LayoutSpec, NodeId } from "./model";

export interface LayoutChildInput {
  id: NodeId;
  x?: number;
  y?: number;
  width: number;
  height: number;
  sizingW: LayoutSizing;
  sizingH: LayoutSizing;
  minW?: number;
  maxW?: number;
  minH?: number;
  maxH?: number;
  /** 绝对定位子项不参与求解 */
  absolute?: boolean;
  /** 隐藏子项退出排布 */
  visible?: boolean;
  /** 该轴由内容决定（hug 或文本自动尺寸）：stretch 不得覆盖 */
  hugW?: boolean;
  hugH?: boolean;
}

export interface LayoutResult {
  id: NodeId;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutSolveResult {
  items: LayoutResult[];
  /** 内容所需尺寸（含 padding），供 hug 容器写回 */
  contentWidth: number;
  contentHeight: number;
}

const clamp = (v: number, min?: number, max?: number): number => {
  let out = v;
  if (min !== undefined) out = Math.max(out, min);
  if (max !== undefined) out = Math.min(out, max);
  return out;
};

/** 尺寸下限至少为 0：fill 分配在空间不足时不能产出负宽高。 */
const clampSize = (v: number, min?: number, max?: number): number => clamp(v, Math.max(0, min ?? 0), max);

interface Line {
  children: LayoutChildInput[];
  main: number;
  cross: number;
}

/**
 * 计算容器内各子节点的位置与尺寸。
 * @param availW/availH 容器 border box 尺寸；undefined 表示该轴 hug
 */
export function solveLayout(
  spec: LayoutSpec,
  children: LayoutChildInput[],
  availW?: number,
  availH?: number,
): LayoutSolveResult {
  const horizontal = spec.direction === "horizontal";
  const pad = spec.padding;
  const contentW = availW === undefined ? undefined : Math.max(0, availW - pad.left - pad.right);
  const contentH = availH === undefined ? undefined : Math.max(0, availH - pad.top - pad.bottom);
  const mainAvail = horizontal ? contentW : contentH;
  const crossAvail = horizontal ? contentH : contentW;

  const participating = children.filter((c) => c.visible !== false && !c.absolute);
  const absolute = children.filter((c) => c.visible !== false && c.absolute);

  const mainOf = (c: LayoutChildInput): number => (horizontal ? c.width : c.height);
  const crossOf = (c: LayoutChildInput): number => (horizontal ? c.height : c.width);
  const mainSizing = (c: LayoutChildInput): LayoutSizing => (horizontal ? c.sizingW : c.sizingH);
  const crossSizing = (c: LayoutChildInput): LayoutSizing => (horizontal ? c.sizingH : c.sizingW);
  const clampMain = (c: LayoutChildInput, v: number): number =>
    clampSize(v, horizontal ? c.minW : c.minH, horizontal ? c.maxW : c.maxH);
  const clampCross = (c: LayoutChildInput, v: number): number =>
    clampSize(v, horizontal ? c.minH : c.minW, horizontal ? c.maxH : c.maxW);
  /** 内在尺寸（hug / 文本自动尺寸）不参与 stretch。 */
  const hugCross = (c: LayoutChildInput): boolean => Boolean(horizontal ? c.hugH : c.hugW);
  const canStretch = (c: LayoutChildInput): boolean => !hugCross(c) && crossSizing(c) !== "hug";

  // 1. 分行
  const lines: Line[] = [];
  if (!spec.wrap || mainAvail === undefined) {
    lines.push({ children: participating, main: 0, cross: 0 });
  } else {
    let current: LayoutChildInput[] = [];
    let used = 0;
    for (const child of participating) {
      const size = mainOf(child);
      const extra = current.length > 0 ? spec.gap + size : size;
      if (current.length > 0 && used + extra > mainAvail + 0.01) {
        lines.push({ children: current, main: 0, cross: 0 });
        current = [child];
        used = size;
      } else {
        current.push(child);
        used += extra;
      }
    }
    lines.push({ children: current, main: 0, cross: 0 });
  }

  // 2. 主轴尺寸：fill 只在单行（不换行）时分配剩余空间
  const sizes = new Map<NodeId, { main: number; cross: number }>();
  for (const line of lines) {
    let usedMain = 0;
    const fills: LayoutChildInput[] = [];
    for (const child of line.children) {
      const sizing = mainSizing(child);
      if (sizing === "fill" && !spec.wrap) {
        fills.push(child);
        usedMain += mainOf(child);
      } else {
        const main = clampMain(child, mainOf(child));
        sizes.set(child.id, { main, cross: 0 });
        usedMain += main;
      }
    }
    usedMain += spec.gap * Math.max(0, line.children.length - 1);
    if (fills.length > 0) {
      const free = (mainAvail ?? usedMain) - usedMain;
      const each = free / fills.length;
      for (const child of fills) {
        const main = clampMain(child, mainOf(child) + each);
        sizes.set(child.id, { main, cross: 0 });
      }
    }
    line.main =
      line.children.reduce((acc, child) => acc + (sizes.get(child.id)?.main ?? 0), 0) +
      spec.gap * Math.max(0, line.children.length - 1);
  }

  // 3. 交叉轴尺寸与行高
  for (const line of lines) {
    for (const child of line.children) {
      const size = sizes.get(child.id)!;
      size.cross = clampCross(child, crossOf(child));
    }
    line.cross = line.children.reduce((acc, child) => Math.max(acc, sizes.get(child.id)?.cross ?? 0), 0);
    if (line.children.length === 0) line.cross = 0;
  }

  const multiLine = lines.length > 1 || spec.wrap;
  const extraCross =
    crossAvail === undefined ? 0 : Math.max(0, crossAvail - (lines.reduce((a, l) => a + l.cross, 0) + spec.crossGap * Math.max(0, lines.length - 1)));

  if (multiLine && spec.alignContent === "stretch" && extraCross > 0) {
    const each = extraCross / lines.length;
    for (const line of lines) {
      line.cross += each;
      if (spec.crossAlign === "stretch") {
        for (const child of line.children) {
          if (canStretch(child)) sizes.get(child.id)!.cross = clampCross(child, line.cross);
        }
      }
    }
  }

  // 单行 stretch：子项撑满内容区交叉轴（fixed 除外）
  if (!spec.wrap && crossAvail !== undefined && spec.crossAlign === "stretch") {
    for (const child of lines[0]?.children ?? []) {
      if (canStretch(child)) sizes.get(child.id)!.cross = clampCross(child, crossAvail);
    }
    if (lines[0]) {
      const stretched = lines[0].children.some((c) => canStretch(c));
      lines[0].cross = Math.max(lines[0].cross, stretched ? crossAvail : 0);
    }
  }

  // 4. 行在交叉轴上的位置
  const linePositions: number[] = [];
  {
    const totalCross =
      lines.reduce((a, l) => a + l.cross, 0) + spec.crossGap * Math.max(0, lines.length - 1);
    let cursor = 0;
    let gapExtra = spec.crossGap;
    if (multiLine && crossAvail !== undefined) {
      if (spec.alignContent === "center") cursor = (crossAvail - totalCross) / 2;
      else if (spec.alignContent === "end") cursor = crossAvail - totalCross;
      else if (spec.alignContent === "space-between" && lines.length > 1) {
        gapExtra = (crossAvail - lines.reduce((a, l) => a + l.cross, 0)) / (lines.length - 1);
      }
    }
    for (const line of lines) {
      linePositions.push(cursor);
      cursor += line.cross + gapExtra;
    }
  }

  // 5. 行内主轴与交叉轴位置
  const results: LayoutResult[] = [];
  lines.forEach((line, lineIndex) => {
    const lineOffset = linePositions[lineIndex] ?? 0;
    let cursor = 0;
    let gapExtra = spec.gap;
    if (mainAvail !== undefined && spec.mainAlign !== "start") {
      if (spec.mainAlign === "center") cursor = (mainAvail - line.main) / 2;
      else if (spec.mainAlign === "end") cursor = mainAvail - line.main;
      else if (spec.mainAlign === "space-between" && line.children.length > 1) {
        const total = line.children.reduce((a, c) => a + (sizes.get(c.id)?.main ?? 0), 0);
        gapExtra = Math.max(0, (mainAvail - total) / (line.children.length - 1));
      }
    }
    for (const child of line.children) {
      const size = sizes.get(child.id)!;
      const crossBox = spec.wrap ? line.cross : (crossAvail ?? line.cross);
      let crossPos = 0;
      if (spec.crossAlign === "center") crossPos = (crossBox - size.cross) / 2;
      else if (spec.crossAlign === "end") crossPos = crossBox - size.cross;
      const mainPad = horizontal ? pad.left : pad.top;
      const crossPad = horizontal ? pad.top : pad.left;
      results.push({
        id: child.id,
        x: horizontal ? mainPad + cursor : crossPad + crossPos + lineOffset,
        y: horizontal ? crossPad + crossPos + lineOffset : mainPad + cursor,
        width: horizontal ? size.main : size.cross,
        height: horizontal ? size.cross : size.main,
      });
      cursor += size.main + gapExtra;
    }
    void lineIndex;
  });

  // 6. 绝对定位：原样保留
  for (const child of absolute) {
    results.push({
      id: child.id,
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width,
      height: child.height,
    });
  }

  const mainContent =
    lines.length === 0 ? 0 : spec.wrap ? Math.max(...lines.map((l) => l.main)) : (lines[0]?.main ?? 0);
  const crossContent =
    lines.reduce((a, l) => a + l.cross, 0) + spec.crossGap * Math.max(0, lines.length - 1);
  const contentWidth = horizontal
    ? mainContent + pad.left + pad.right
    : crossContent + pad.left + pad.right;
  const contentHeight = horizontal
    ? crossContent + pad.top + pad.bottom
    : mainContent + pad.top + pad.bottom;

  return { items: results, contentWidth, contentHeight };
}
