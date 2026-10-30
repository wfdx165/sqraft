/**
 * 裁切模式的 UI 叠加层：图外压暗、框线加粗、四角画手柄。
 * 文档层仍按当前 crop 渲染，所以拖动时看到的就是最终结果。
 */
import { worldQuad, type DocState, type NodeId } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";

const MASK = "rgba(15, 23, 42, 0.32)";
const ACCENT = "#6366f1";
const HANDLE = 8;

export function paintCropOverlay(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  doc: DocState,
  id: NodeId | null,
): void {
  if (!id) return;
  const quad = worldQuad(doc, id);
  if (!quad) return;
  const points = quad.map((p) => worldToScreen(vp, p.x, p.y));

  ctx.save();
  // 图外压暗：视口矩形 + 图片四边形，evenodd 抠出中间
  ctx.beginPath();
  ctx.rect(0, 0, vp.width, vp.height);
  ctx.moveTo(points[0].x, points[0].y);
  for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.fillStyle = MASK;
  ctx.fill("evenodd");

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 四角手柄
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  for (const p of points) {
    ctx.beginPath();
    ctx.rect(p.x - HANDLE / 2, p.y - HANDLE / 2, HANDLE, HANDLE);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
