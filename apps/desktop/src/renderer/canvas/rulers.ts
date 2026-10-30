/**
 * 标尺与参考线（UI 叠加层）。
 *
 * 标尺刻度随缩放自适应；参考线存在页面上（页面本地坐标），只画在这里，
 * 不进文档渲染、不出现在截图里。
 */
import type { DocNode, Rect } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";

export const RULER_SIZE = 26;

const TICK_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const BG = "rgba(255, 255, 255, 0.92)";
const LINE = "rgba(15, 23, 42, 0.12)";
const TEXT = "rgba(15, 23, 42, 0.45)";
const SELECTION = "rgba(79, 70, 229, 0.85)";
const GUIDE = "rgba(79, 70, 229, 0.55)";

/** 刻度间距：屏幕上至少 60px 一个主刻度。 */
function stepFor(zoom: number): number {
  for (const step of TICK_STEPS) {
    if (step * zoom >= 60) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

export function drawRulers(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  page: DocNode | null,
  selection: Rect | null,
): void {
  const step = stepFor(vp.zoom);
  ctx.save();
  ctx.font = "9px ui-monospace, monospace";
  ctx.textBaseline = "top";

  // 顶部与左侧底
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, vp.width, RULER_SIZE);
  ctx.fillRect(0, 0, RULER_SIZE, vp.height);

  // 选中范围高亮
  if (page && selection) {
    const tl = worldToScreen(vp, selection.x, selection.y);
    const br = worldToScreen(vp, selection.x + selection.width, selection.y + selection.height);
    ctx.fillStyle = SELECTION;
    ctx.fillRect(tl.x, RULER_SIZE - 3, Math.max(1, br.x - tl.x), 3);
    ctx.fillRect(RULER_SIZE - 3, tl.y, 3, Math.max(1, br.y - tl.y));
  }

  ctx.strokeStyle = LINE;
  ctx.fillStyle = TEXT;
  ctx.lineWidth = 1;

  // 竖刻度（顶部）
  const startX = Math.floor(vp.x / step) * step;
  const endX = vp.x + vp.width / vp.zoom;
  for (let wx = startX; wx <= endX; wx += step) {
    const sx = Math.round(worldToScreen(vp, wx, 0).x) + 0.5;
    if (sx < RULER_SIZE) continue;
    ctx.beginPath();
    ctx.moveTo(sx, RULER_SIZE - 6);
    ctx.lineTo(sx, RULER_SIZE);
    ctx.stroke();
    ctx.fillText(String(Math.round(wx)), sx + 3, 6);
  }

  // 横刻度（左侧）
  const startY = Math.floor(vp.y / step) * step;
  const endY = vp.y + vp.height / vp.zoom;
  for (let wy = startY; wy <= endY; wy += step) {
    const sy = Math.round(worldToScreen(vp, 0, wy).y) + 0.5;
    if (sy < RULER_SIZE) continue;
    ctx.beginPath();
    ctx.moveTo(RULER_SIZE - 6, sy);
    ctx.lineTo(RULER_SIZE, sy);
    ctx.stroke();
    ctx.save();
    ctx.translate(6, sy + 3);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(String(Math.round(wy)), 0, 0);
    ctx.restore();
  }

  // 左上角遮住刻度交叉
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, RULER_SIZE, RULER_SIZE);
  ctx.restore();
}

/** 参考线：横线取 y 列表、竖线取 x 列表（页面本地坐标）。 */
export function drawGuidesOverlay(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  page: DocNode | null,
  preview?: { axis: "x" | "y"; world: number } | null,
): void {
  if (!page) return;
  ctx.save();
  ctx.strokeStyle = GUIDE;
  ctx.lineWidth = 1;

  const line = (axis: "x" | "y", world: number) => {
    const point = axis === "x" ? worldToScreen(vp, world, 0) : worldToScreen(vp, 0, world);
    ctx.beginPath();
    if (axis === "x") {
      ctx.moveTo(Math.round(point.x) + 0.5, RULER_SIZE);
      ctx.lineTo(Math.round(point.x) + 0.5, vp.height);
    } else {
      ctx.moveTo(RULER_SIZE, Math.round(point.y) + 0.5);
      ctx.lineTo(vp.width, Math.round(point.y) + 0.5);
    }
    ctx.stroke();
  };

  for (const x of page.guides?.x ?? []) line("x", page.x + x);
  for (const y of page.guides?.y ?? []) line("y", page.y + y);
  if (preview) line(preview.axis, preview.world);
  ctx.restore();
}

/** 命中参考线（屏幕坐标，4px 以内）：返回要删除的那一条。 */
export function guideAt(
  vp: Viewport,
  page: DocNode | null,
  sx: number,
  sy: number,
): { axis: "x" | "y"; index: number } | null {
  if (!page) return null;
  const xs = page.guides?.x ?? [];
  for (let i = 0; i < xs.length; i += 1) {
    if (Math.abs(worldToScreen(vp, page.x + xs[i], 0).x - sx) <= 4) return { axis: "x", index: i };
  }
  const ys = page.guides?.y ?? [];
  for (let i = 0; i < ys.length; i += 1) {
    if (Math.abs(worldToScreen(vp, 0, page.y + ys[i]).y - sy) <= 4) return { axis: "y", index: i };
  }
  return null;
}
