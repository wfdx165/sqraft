/**
 * 页面参考线（UI 叠加层）。
 *
 * 标尺与"从标尺拖出参考线"已在 0.1.2 移除（ADR-0041）：这里只负责画已有的线，
 * 以及命中判定（双击删除）。参考线存在页面上（页面本地坐标），不进文档渲染、不出现在截图里。
 */
import type { DocNode } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";

const GUIDE = "rgba(79, 70, 229, 0.55)";

/** 已有参考线：横线取 y 列表、竖线取 x 列表（页面本地坐标）。 */
export function drawGuidesOverlay(ctx: CanvasRenderingContext2D, vp: Viewport, page: DocNode | null): void {
  if (!page) return;
  ctx.save();
  ctx.strokeStyle = GUIDE;
  ctx.lineWidth = 1;

  const line = (axis: "x" | "y", world: number) => {
    const point = axis === "x" ? worldToScreen(vp, world, 0) : worldToScreen(vp, 0, world);
    ctx.beginPath();
    if (axis === "x") {
      ctx.moveTo(Math.round(point.x) + 0.5, 0);
      ctx.lineTo(Math.round(point.x) + 0.5, vp.height);
    } else {
      ctx.moveTo(0, Math.round(point.y) + 0.5);
      ctx.lineTo(vp.width, Math.round(point.y) + 0.5);
    }
    ctx.stroke();
  };

  for (const x of page.guides?.x ?? []) line("x", page.x + x);
  for (const y of page.guides?.y ?? []) line("y", page.y + y);
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
