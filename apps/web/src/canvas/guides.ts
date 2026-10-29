/**
 * 页面参考线与间距标注：纯数据计算 + 屏幕空间绘制。
 * 只服务页面拖动（普通图层不参与）。
 */
import { worldRect, type DocNode, type NodeId, type Rect } from "@sqraft/core";
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

const SNAP_PX = 6;
const GUIDE_COLOR = "rgba(244, 63, 142, 0.95)";
const GUIDE_TEXT_COLOR = "#c9166b";

export function unionRects(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 页面间参考线：边/中线吸附 + 与最近页面的间距标注。
 * 返回修正后的偏移与要绘制的线；提交时仍是一条 node.update 命令。
 */
export function computeGuides(
  dragRects: Rect[],
  targets: Rect[],
  offset: { dx: number; dy: number },
  zoom: number,
): GuideResult {
  const lines: GuideLine[] = [];
  const gaps: GapMark[] = [];
  if (targets.length === 0 || dragRects.length === 0) return { lines, gaps, dx: offset.dx, dy: offset.dy };

  let dx = offset.dx;
  let dy = offset.dy;
  const threshold = SNAP_PX / zoom;
  const moved = unionRects(dragRects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })));
  const movedXs = [moved.x, moved.x + moved.width / 2, moved.x + moved.width];
  const movedYs = [moved.y, moved.y + moved.height / 2, moved.y + moved.height];

  let bestX: { delta: number; at: number; target: Rect } | null = null;
  let bestY: { delta: number; at: number; target: Rect } | null = null;
  for (const t of targets) {
    for (const ax of [t.x, t.x + t.width / 2, t.x + t.width]) {
      for (const mx of movedXs) {
        const delta = ax - mx;
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
          bestX = { delta, at: ax, target: t };
        }
      }
    }
    for (const ay of [t.y, t.y + t.height / 2, t.y + t.height]) {
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
  return { lines, gaps, dx, dy };
}

/** 页面参考线与间距标注（屏幕空间固定像素粗细/字号）。 */
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

/** 拖动页面的参考线上下文：只有页面参与边/中线对齐与间距标注。 */
export function pageDragContext(selection: readonly NodeId[]): { dragPages: Rect[]; snapTargets: Rect[] } {
  const dragPages = selection
    .map((id) => docStore.doc.nodes[id])
    .filter((n): n is DocNode => Boolean(n) && n!.type === "page")
    .map((n) => worldRect(docStore.doc, n.id))
    .filter((r): r is Rect => Boolean(r));
  const snapTargets =
    dragPages.length === 0
      ? []
      : docStore.doc.rootIds
          .filter((pid) => !selection.includes(pid))
          .map((pid) => docStore.doc.nodes[pid])
          .filter((p): p is DocNode => Boolean(p) && p!.type === "page")
          .map((p) => worldRect(docStore.doc, p.id))
          .filter((r): r is Rect => Boolean(r));
  return { dragPages, snapTargets };
}
