/**
 * 参考线（对齐吸附 + 间距标注）：纯数据计算 + 屏幕空间绘制。
 * 拖动 / 绘制 / 缩放共用同一套目标：同父兄弟 + 父容器内容区 + 父容器边界。
 * 目标几何统一用 `worldRect`（累加祖先平移的轴对齐包围盒）。
 */
import { paddingOf, unionRects, worldRect, type DocNode, type NodeId, type Rect } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { docStore } from "../store";

export interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GapMark {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  value: number;
}

export interface GuideResult {
  lines: GuideLine[];
  gaps: GapMark[];
  /** 吸附修正后的拖动偏移 */
  dx: number;
  dy: number;
}

/** 一次拖拽期间固定的参考线上下文。 */
export interface GuideContext {
  /** 对齐 / 间距候选（世界坐标） */
  targets: Rect[];
  /** 父容器内容区（padding 内框；没有布局时等于父边界） */
  content: Rect | null;
}

const SNAP_PX = 6;
const GUIDE_COLOR = "rgba(244, 63, 142, 0.95)";
const GUIDE_TEXT_COLOR = "#c9166b";

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** 节点自身与祖先都可见才算可见（隐藏容器里的东西不做吸附目标）。 */
function isVisibleInTree(id: NodeId): boolean {
  let cur: DocNode | undefined = docStore.doc.nodes[id];
  while (cur) {
    if (cur.visible === false) return false;
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  return true;
}

/** 父容器的内容区：有布局时按四边 padding 内缩，否则等于自身边界。 */
export function contentBoxOf(parent: DocNode): Rect | null {
  const bounds = worldRect(docStore.doc, parent.id);
  if (!bounds) return null;
  if (!parent.layout) return bounds;
  const p = paddingOf(parent.layout);
  return {
    x: bounds.x + p.left,
    y: bounds.y + p.top,
    width: Math.max(0, bounds.width - p.left - p.right),
    height: Math.max(0, bounds.height - p.top - p.bottom),
  };
}

/** 某个父容器下的参考线上下文：兄弟 + 内容区 + 父边界。 */
export function guideContextForParent(
  parentId: NodeId | null,
  exclude: readonly NodeId[] = [],
): GuideContext {
  const state = docStore.doc;
  const parent = parentId ? state.nodes[parentId] : null;
  const siblingIds = parent ? parent.children : state.rootIds;
  const skip = new Set(exclude);
  const targets: Rect[] = [];
  for (const id of siblingIds) {
    if (skip.has(id) || !isVisibleInTree(id)) continue;
    const r = worldRect(state, id);
    if (r) targets.push(r);
  }
  if (!parent) return { targets, content: null };
  const bounds = worldRect(state, parent.id);
  if (!bounds) return { targets, content: null };
  // 父边界本身也是对齐目标（贴边 / 贴留白）
  targets.push(bounds);
  const content = contentBoxOf(parent);
  if (content && !sameRect(content, bounds)) targets.push(content);
  return { targets, content: content ?? bounds };
}

/**
 * 选中对象的参考线上下文。
 * 只取“移动根”（父节点也被选中的子节点不重复参与），且所有根必须同父；
 * 跨父容器拖动时不出参考线。拖动页面时父容器为空，候选就是其它页面。
 */
export function guideContextFor(ids: readonly NodeId[]): GuideContext | null {
  if (ids.length === 0) return null;
  const roots = ids.filter((id) => {
    const n = docStore.doc.nodes[id];
    return Boolean(n) && (!n!.parentId || !ids.includes(n!.parentId));
  });
  if (roots.length === 0) return null;
  const parents = new Set(roots.map((id) => docStore.doc.nodes[id]?.parentId ?? null));
  if (parents.size !== 1) return null;
  return guideContextForParent([...parents][0], ids);
}

/** 间距标注：每个轴取最近的一对可见间距（含到父内容区的距离）。 */
export function computeGapMarks(box: Rect, targets: Rect[]): GapMark[] {
  const gaps: GapMark[] = [];
  let bestH: { gap: number; a: number; b: number; y: number } | null = null;
  let bestV: { gap: number; a: number; b: number; x: number } | null = null;
  for (const t of targets) {
    const oyTop = Math.max(box.y, t.y);
    const oyBottom = Math.min(box.y + box.height, t.y + t.height);
    if (oyBottom - oyTop > 1) {
      const y = (oyTop + oyBottom) / 2;
      const gapRight = t.x - (box.x + box.width);
      const gapLeft = box.x - (t.x + t.width);
      if (gapRight > 0.5 && (!bestH || gapRight < bestH.gap)) bestH = { gap: gapRight, a: box.x + box.width, b: t.x, y };
      if (gapLeft > 0.5 && (!bestH || gapLeft < bestH.gap)) bestH = { gap: gapLeft, a: box.x, b: t.x + t.width, y };
    }
    const oxLeft = Math.max(box.x, t.x);
    const oxRight = Math.min(box.x + box.width, t.x + t.width);
    if (oxRight - oxLeft > 1) {
      const x = (oxLeft + oxRight) / 2;
      const gapBelow = t.y - (box.y + box.height);
      const gapAbove = box.y - (t.y + t.height);
      if (gapBelow > 0.5 && (!bestV || gapBelow < bestV.gap)) bestV = { gap: gapBelow, a: box.y + box.height, b: t.y, x };
      if (gapAbove > 0.5 && (!bestV || gapAbove < bestV.gap)) bestV = { gap: gapAbove, a: box.y, b: t.y + t.height, x };
    }
  }
  if (bestH) gaps.push({ x1: bestH.a, y1: bestH.y, x2: bestH.b, y2: bestH.y, value: Math.round(bestH.gap) });
  if (bestV) gaps.push({ x1: bestV.x, y1: bestV.a, x2: bestV.x, y2: bestV.b, value: Math.round(bestV.gap) });
  return gaps;
}

/** 每轴 3 个对齐点：起边 / 中心 / 终边。 */
function anchors(rect: Rect, axis: "x" | "y"): number[] {
  return axis === "x"
    ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
    : [rect.y, rect.y + rect.height / 2, rect.y + rect.height];
}

/**
 * 拖动参考线：边/中线吸附 + 最近间距。
 * 返回修正后的偏移与要绘制的线；提交时仍是一条 node.update 命令。
 */
export function computeGuides(
  dragRects: Rect[],
  targets: Rect[],
  offset: { dx: number; dy: number },
  zoom: number,
): GuideResult {
  const lines: GuideLine[] = [];
  if (targets.length === 0 || dragRects.length === 0) {
    return { lines, gaps: [], dx: offset.dx, dy: offset.dy };
  }

  let dx = offset.dx;
  let dy = offset.dy;
  const threshold = SNAP_PX / zoom;
  const moved = unionRects(dragRects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })));
  if (!moved) return { lines, gaps: [], dx: offset.dx, dy: offset.dy };
  const movedXs = anchors(moved, "x");
  const movedYs = anchors(moved, "y");

  let bestX: { delta: number; at: number; target: Rect } | null = null;
  let bestY: { delta: number; at: number; target: Rect } | null = null;
  for (const t of targets) {
    for (const ax of anchors(t, "x")) {
      for (const mx of movedXs) {
        const delta = ax - mx;
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
          bestX = { delta, at: ax, target: t };
        }
      }
    }
    for (const ay of anchors(t, "y")) {
      for (const my of movedYs) {
        const delta = ay - my;
        if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
          bestY = { delta, at: ay, target: t };
        }
      }
    }
  }

  if (bestX) {
    dx += bestX.delta;
    lines.push({
      x1: bestX.at,
      y1: Math.min(moved.y, bestX.target.y),
      x2: bestX.at,
      y2: Math.max(moved.y + moved.height, bestX.target.y + bestX.target.height),
    });
  }
  if (bestY) {
    dy += bestY.delta;
    lines.push({
      x1: Math.min(moved.x, bestY.target.x),
      y1: bestY.at,
      x2: Math.max(moved.x + moved.width, bestY.target.x + bestY.target.width),
      y2: bestY.at,
    });
  }

  const box = unionRects(dragRects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })));
  return { lines, gaps: box ? computeGapMarks(box, targets) : [], dx, dy };
}

export interface SnapRectResult {
  rect: Rect;
  lines: GuideLine[];
  gaps: GapMark[];
}

/**
 * 缩放吸附：只修正被拖动的边（`handle` 含 e / w / n / s），固定边不动。
 * `min` 用来避免吸附把尺寸压到下限以下——压到就放弃该轴吸附。
 */
export function snapResizeRect(
  rect: Rect,
  handle: string,
  targets: Rect[],
  zoom: number,
  min: number,
): SnapRectResult {
  const threshold = SNAP_PX / zoom;
  const lines: GuideLine[] = [];
  let { x, y, width, height } = rect;

  const bestFor = (edge: number, axis: "x" | "y") => {
    let best: { delta: number; at: number; target: Rect } | null = null;
    for (const t of targets) {
      for (const at of anchors(t, axis)) {
        const delta = at - edge;
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
          best = { delta, at, target: t };
        }
      }
    }
    return best;
  };

  if (handle.includes("e")) {
    const hit = bestFor(x + width, "x");
    if (hit && width + hit.delta >= min) {
      width += hit.delta;
      lines.push({ x1: hit.at, y1: Math.min(y, hit.target.y), x2: hit.at, y2: Math.max(y + height, hit.target.y + hit.target.height) });
    }
  }
  if (handle.includes("w")) {
    const hit = bestFor(x, "x");
    if (hit && width - hit.delta >= min) {
      x += hit.delta;
      width -= hit.delta;
      lines.push({ x1: hit.at, y1: Math.min(y, hit.target.y), x2: hit.at, y2: Math.max(y + height, hit.target.y + hit.target.height) });
    }
  }
  if (handle.includes("s")) {
    const hit = bestFor(y + height, "y");
    if (hit && height + hit.delta >= min) {
      height += hit.delta;
      lines.push({ x1: Math.min(x, hit.target.x), y1: hit.at, x2: Math.max(x + width, hit.target.x + hit.target.width), y2: hit.at });
    }
  }
  if (handle.includes("n")) {
    const hit = bestFor(y, "y");
    if (hit && height - hit.delta >= min) {
      y += hit.delta;
      height -= hit.delta;
      lines.push({ x1: Math.min(x, hit.target.x), y1: hit.at, x2: Math.max(x + width, hit.target.x + hit.target.width), y2: hit.at });
    }
  }

  const snapped = { x, y, width, height };
  return { rect: snapped, lines, gaps: computeGapMarks(snapped, targets) };
}

/**
 * 绘制吸附：只修正指针那一角（起点是锚，不能动）。
 * `pointerRight/pointerDown` 表示当前指针在起点右侧 / 下方（决定拖的是哪条边）。
 */
export function snapDrawRect(
  rect: Rect,
  pointerRight: boolean,
  pointerDown: boolean,
  targets: Rect[],
  zoom: number,
): SnapRectResult {
  const handle = `${pointerDown ? "s" : "n"}${pointerRight ? "e" : "w"}`;
  return snapResizeRect(rect, handle, targets, zoom, 1);
}

/** 参考线与间距标注（屏幕空间固定像素粗细/字号）。 */
export function drawGuides(
  g: CanvasRenderingContext2D,
  vp: Viewport,
  guideLines: GuideLine[],
  gapMarks: GapMark[],
): void {
  if (guideLines.length === 0 && gapMarks.length === 0) return;
  g.save();
  g.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);

  g.strokeStyle = GUIDE_COLOR;
  g.lineWidth = 1;
  for (const line of guideLines) {
    const a = worldToScreen(vp, line.x1, line.y1);
    const b = worldToScreen(vp, line.x2, line.y2);
    g.beginPath();
    g.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
    g.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
    g.stroke();
  }

  g.font = "10px 'Geist Mono Variable', ui-monospace, monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const mark of gapMarks) {
    const a = worldToScreen(vp, mark.x1, mark.y1);
    const b = worldToScreen(vp, mark.x2, mark.y2);
    const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    if (horizontal) {
      g.moveTo(a.x, a.y - 4);
      g.lineTo(a.x, a.y + 4);
      g.moveTo(b.x, b.y - 4);
      g.lineTo(b.x, b.y + 4);
    } else {
      g.moveTo(a.x - 4, a.y);
      g.lineTo(a.x + 4, a.y);
      g.moveTo(b.x - 4, b.y);
      g.lineTo(b.x + 4, b.y);
    }
    g.stroke();

    const label = String(mark.value);
    const w = g.measureText(label).width + 10;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    g.fillStyle = "rgba(255, 255, 255, 0.96)";
    g.beginPath();
    (g as unknown as { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(
      cx - w / 2,
      cy - 8,
      w,
      16,
      4,
    );
    g.fill();
    g.fillStyle = GUIDE_TEXT_COLOR;
    g.fillText(label, cx, cy + 0.5);
  }

  g.restore();
}
