/**
 * 页面名称标签：画布叠加层绘制与命中。
 * 标签是编辑模式下移动整页的唯一入口，因此命中与绘制共用同一几何计算。
 */
import type { DocNode } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { docStore } from "../store";

const LABEL_FONT = "11px 'Geist Variable', 'PingFang SC', sans-serif";
const ACTIVE_PAGE_ALPHA = 0.35;

export interface PageLabelDrawOptions {
  pageRenameId: string | null;
  drag: { mode: string; moved: boolean; offsetX: number; offsetY: number } | null;
  resizePreview: { id: string; x: number; y: number; width: number; height: number } | null;
  selection: readonly string[];
  activePageId: string | null;
  mode: string;
}

export function drawPageLabels(g: CanvasRenderingContext2D, vp: Viewport, opts: PageLabelDrawOptions): void {
  g.save();
  g.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  g.font = LABEL_FONT;
  g.textBaseline = "alphabetic";
  for (const pageId of docStore.doc.rootIds) {
    const page = docStore.doc.nodes[pageId];
    if (!page || page.type !== "page") continue;
    if (opts.pageRenameId === page.id) continue;
    const moving = opts.drag && opts.drag.mode === "move" && opts.drag.moved && opts.selection.includes(page.id);
    const rp = opts.resizePreview && opts.resizePreview.id === page.id ? opts.resizePreview : null;
    const a = worldToScreen(
      vp,
      (rp ? rp.x : page.x) + (moving ? opts.drag!.offsetX : 0),
      (rp ? rp.y : page.y) + (moving ? opts.drag!.offsetY : 0),
    );
    if (a.x > vp.width || a.y > vp.height + 20) continue;
    const label = page.name;
    const tw = g.measureText(label).width;
    g.globalAlpha = opts.mode === "edit" && opts.activePageId !== page.id ? ACTIVE_PAGE_ALPHA : 1;
    g.fillStyle = "rgba(255,255,255,0.72)";
    g.beginPath();
    (g as unknown as { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(
      a.x - 6,
      a.y - 24,
      tw + 12,
      18,
      6,
    );
    g.fill();
    g.fillStyle = "rgba(23, 23, 28, 0.62)";
    g.fillText(label, a.x, a.y - 11);
    g.globalAlpha = 1;
  }
  g.restore();
}

/** 页面名称标签的屏幕矩形（与 drawPageLabels 保持一致）。 */
export function pageLabelRect(
  page: DocNode,
  vp: Viewport,
  ctx: CanvasRenderingContext2D | null,
): { x: number; y: number; width: number; height: number } {
  const a = worldToScreen(vp, page.x, page.y);
  let tw = page.name.length * 11;
  if (ctx) {
    ctx.save();
    ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
    ctx.font = LABEL_FONT;
    tw = ctx.measureText(page.name).width;
    ctx.restore();
  }
  return { x: a.x - 6, y: a.y - 24, width: tw + 12, height: 18 };
}

export function labelAt(
  sx: number,
  sy: number,
  vp: Viewport,
  ctx: CanvasRenderingContext2D | null,
): DocNode | null {
  for (const pageId of docStore.doc.rootIds) {
    const page = docStore.doc.nodes[pageId];
    if (!page || page.type !== "page") continue;
    const r = pageLabelRect(page, vp, ctx);
    if (sx >= r.x && sx <= r.x + r.width && sy >= r.y && sy <= r.y + r.height) return page;
  }
  return null;
}
