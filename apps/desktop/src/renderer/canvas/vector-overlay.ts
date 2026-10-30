/**
 * 画布叠加层：钢笔草稿、锚点编辑、形状拖拽预览。
 * 纯绘制函数（显式传参、不持有状态），与文档/事件解耦，便于单独阅读与测试。
 * 屏幕空间绘制：调用方保证 ctx 已处于未变换状态（这些函数自己 setTransform）。
 */

import { polygonPoints, vectorBounds, type DocNode, type VectorAnchor, type VectorPath } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";

export interface PenDraftView {
  anchors: VectorAnchor[];
}

/** 拖拽预览：世界坐标矩形，w/h 可为负（方向未归一化）。 */
export interface ShapePreview {
  x: number;
  y: number;
  w: number;
  h: number;
  valid: boolean;
}

/** 在屏幕空间描出一条路径（不含填充样式；调用方设置 stroke/fill）。 */
export function traceVectorScreen(
  g: CanvasRenderingContext2D,
  vector: VectorPath,
  toScreen: (x: number, y: number) => { x: number; y: number },
): void {
  const anchors = vector.anchors;
  if (anchors.length < 2) return;
  const p0 = toScreen(anchors[0].x, anchors[0].y);
  g.beginPath();
  g.moveTo(p0.x, p0.y);
  const segments = vector.closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    const curved = a.outX !== 0 || a.outY !== 0 || b.inX !== 0 || b.inY !== 0;
    const p = toScreen(b.x, b.y);
    if (curved) {
      const c1 = toScreen(a.x + a.outX, a.y + a.outY);
      const c2 = toScreen(b.x + b.inX, b.y + b.inY);
      g.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
    } else {
      g.lineTo(p.x, p.y);
    }
  }
  if (vector.closed) g.closePath();
}

function drawAnchorDot(g: CanvasRenderingContext2D, x: number, y: number, active: boolean): void {
  g.beginPath();
  g.rect(x - 2.5, y - 2.5, 5, 5);
  g.fillStyle = active ? "#4f46e5" : "#ffffff";
  g.fill();
  g.strokeStyle = "#4f46e5";
  g.lineWidth = 1.25;
  g.stroke();
}

/** 钢笔草稿：已落下的锚点、当前锚点手柄、橡皮筋与首锚吸附高亮。 */
export function drawDraftPath(
  g: CanvasRenderingContext2D,
  vp: Viewport,
  draft: PenDraftView | null,
  hover: { x: number; y: number } | null,
): void {
  if (!draft || draft.anchors.length === 0) return;
  g.save();
  g.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  const toScreen = (x: number, y: number) => worldToScreen(vp, x, y);
  const vector: VectorPath = { closed: false, anchors: draft.anchors };

  g.strokeStyle = "#4f46e5";
  g.lineWidth = 1.5;
  g.lineCap = "round";
  g.lineJoin = "round";
  traceVectorScreen(g, vector, toScreen);
  g.stroke();

  // 橡皮筋：最后一个锚点的出手柄 → 光标
  if (hover) {
    const last = draft.anchors[draft.anchors.length - 1];
    const a = toScreen(last.x, last.y);
    const p = toScreen(hover.x, hover.y);
    g.beginPath();
    g.moveTo(a.x, a.y);
    if (last.outX || last.outY) {
      const c = toScreen(last.x + last.outX, last.y + last.outY);
      g.bezierCurveTo(c.x, c.y, p.x, p.y, p.x, p.y);
    } else {
      g.lineTo(p.x, p.y);
    }
    g.setLineDash([4, 4]);
    g.strokeStyle = "rgba(79, 70, 229, 0.5)";
    g.lineWidth = 1;
    g.stroke();
    g.setLineDash([]);
  }

  // 当前锚点的两根手柄
  const last = draft.anchors[draft.anchors.length - 1];
  if (last) {
    const ap = toScreen(last.x, last.y);
    g.strokeStyle = "rgba(79, 70, 229, 0.55)";
    g.lineWidth = 1;
    for (const [hx, hy] of [
      [last.inX, last.inY],
      [last.outX, last.outY],
    ]) {
      if (!hx && !hy) continue;
      const hp = toScreen(last.x + hx, last.y + hy);
      g.beginPath();
      g.moveTo(ap.x, ap.y);
      g.lineTo(hp.x, hp.y);
      g.stroke();
      g.beginPath();
      g.arc(hp.x, hp.y, 2.5, 0, Math.PI * 2);
      g.fillStyle = "#ffffff";
      g.fill();
      g.strokeStyle = "#4f46e5";
      g.stroke();
      g.strokeStyle = "rgba(79, 70, 229, 0.55)";
    }
  }

  // 全部锚点
  for (let i = 0; i < draft.anchors.length; i++) {
    const a = draft.anchors[i];
    const p = toScreen(a.x, a.y);
    drawAnchorDot(g, p.x, p.y, i === draft.anchors.length - 1);
  }

  // 首锚吸附：8px 内高亮闭合
  if (hover && draft.anchors.length >= 3) {
    const first = draft.anchors[0];
    const fp = toScreen(first.x, first.y);
    const pp = toScreen(hover.x, hover.y);
    if (Math.hypot(pp.x - fp.x, pp.y - fp.y) <= 8) {
      g.beginPath();
      g.arc(fp.x, fp.y, 7, 0, Math.PI * 2);
      g.strokeStyle = "#4f46e5";
      g.lineWidth = 1.5;
      g.stroke();
    }
  }
  g.restore();
}

export interface PathEditingView {
  /** 正在编辑的节点（含 vector） */
  node: DocNode;
  /** 节点在世界坐标中的左上角 */
  origin: { x: number; y: number };
  /** 当前锚点下标 */
  active: number;
  /** 拖动中的几何预览（世界坐标）；为空时用文档几何 */
  preview: VectorPath | null;
  /** 整条路径移动中的偏移（拖本体） */
  move: { dx: number; dy: number };
}

/** 锚点编辑态：包围盒 + 路径轮廓 + 当前锚点手柄 + 全部锚点。 */
export function drawPathEditing(g: CanvasRenderingContext2D, vp: Viewport, view: PathEditingView): void {
  const { node, origin } = view;
  if (!node.vector) return;
  const vector: VectorPath = view.preview ?? {
    closed: node.vector.closed,
    anchors: node.vector.anchors.map((a) => ({
      ...a,
      x: a.x + origin.x + view.move.dx,
      y: a.y + origin.y + view.move.dy,
    })),
  };
  const toScreen = (x: number, y: number) => worldToScreen(vp, x, y);

  g.save();
  g.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);

  // 包围盒（锚点编辑时不显示缩放手柄）
  const bounds = vectorBounds(vector);
  const a = toScreen(bounds.x, bounds.y);
  const b = toScreen(bounds.x + bounds.width, bounds.y + bounds.height);
  g.save();
  g.setLineDash([4, 3]);
  g.strokeStyle = "rgba(79, 70, 229, 0.35)";
  g.lineWidth = 1;
  g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
  g.restore();

  // 路径轮廓
  g.strokeStyle = "#4f46e5";
  g.lineWidth = 1.5;
  g.lineCap = "round";
  g.lineJoin = "round";
  traceVectorScreen(g, vector, toScreen);
  g.stroke();

  const active = Math.max(0, Math.min(view.active, vector.anchors.length - 1));
  const selected = vector.anchors[active];
  if (selected) {
    const ap = toScreen(selected.x, selected.y);
    g.strokeStyle = "rgba(79, 70, 229, 0.55)";
    g.lineWidth = 1;
    for (const [hx, hy] of [
      [selected.inX, selected.inY],
      [selected.outX, selected.outY],
    ]) {
      if (!hx && !hy) continue;
      const hp = toScreen(selected.x + hx, selected.y + hy);
      g.beginPath();
      g.moveTo(ap.x, ap.y);
      g.lineTo(hp.x, hp.y);
      g.stroke();
      g.beginPath();
      g.arc(hp.x, hp.y, 3, 0, Math.PI * 2);
      g.fillStyle = "#ffffff";
      g.fill();
      g.strokeStyle = "#4f46e5";
      g.stroke();
      g.strokeStyle = "rgba(79, 70, 229, 0.55)";
    }
  }

  for (let i = 0; i < vector.anchors.length; i++) {
    const anchor = vector.anchors[i];
    const p = toScreen(anchor.x, anchor.y);
    drawAnchorDot(g, p.x, p.y, i === active);
  }
  g.restore();
}

/**
 * 拖拽创建的形状预览：直线画真实线段、三角形画真实轮廓、其它画虚线包围盒。
 * `tool` 用起笔时的工具（拖动中切工具不改预览）。
 */
export function drawShapePreview(
  g: CanvasRenderingContext2D,
  vp: Viewport,
  preview: ShapePreview,
  tool: string | null,
): void {
  if (tool === "line") {
    const p0 = worldToScreen(vp, preview.x, preview.y);
    const p1 = worldToScreen(vp, preview.x + preview.w, preview.y + preview.h);
    g.strokeStyle = preview.valid ? "rgba(79, 70, 229, 0.9)" : "rgba(214, 69, 69, 0.9)";
    g.fillStyle = preview.valid ? "#4f46e5" : "#d64545";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(p0.x, p0.y);
    g.lineTo(p1.x, p1.y);
    g.stroke();
    for (const p of [p0, p1]) {
      g.beginPath();
      g.arc(p.x, p.y, 2, 0, Math.PI * 2);
      g.fill();
    }
    return;
  }
  if (tool === "triangle") {
    const x0 = Math.min(preview.x, preview.x + preview.w);
    const y0 = Math.min(preview.y, preview.y + preview.h);
    const pts = polygonPoints(3, Math.max(1, Math.abs(preview.w)), Math.max(1, Math.abs(preview.h)));
    g.beginPath();
    pts.forEach((p, i) => {
      const s = worldToScreen(vp, x0 + p.x, y0 + p.y);
      if (i === 0) g.moveTo(s.x, s.y);
      else g.lineTo(s.x, s.y);
    });
    g.closePath();
    g.fillStyle = preview.valid ? "rgba(79, 70, 229, 0.14)" : "rgba(214, 69, 69, 0.12)";
    g.fill();
    g.strokeStyle = preview.valid ? "rgba(79, 70, 229, 0.9)" : "rgba(214, 69, 69, 0.9)";
    g.lineWidth = 1.5;
    g.stroke();
    return;
  }
  const a = worldToScreen(vp, Math.min(preview.x, preview.x + preview.w), Math.min(preview.y, preview.y + preview.h));
  const b = worldToScreen(vp, Math.max(preview.x, preview.x + preview.w), Math.max(preview.y, preview.y + preview.h));
  g.fillStyle = preview.valid ? "rgba(79, 70, 229, 0.08)" : "rgba(214, 69, 69, 0.08)";
  g.strokeStyle = preview.valid ? "rgba(79, 70, 229, 0.65)" : "rgba(214, 69, 69, 0.75)";
  g.lineWidth = 1.25;
  g.setLineDash([5, 4]);
  g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  g.setLineDash([]);
}
