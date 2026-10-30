/**
 * 拖拽换父级的落点叠加层：目标画板/组件画虚线外框，页面画整页外框。
 * 纯 UI 叠加层，不进入文档渲染 / 导出 / AI 截图。
 */
import { worldRect } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { docStore } from "../store";
import type { DropTarget } from "./drop-target";

export function paintDropTarget(g: CanvasRenderingContext2D, vp: Viewport, drop: DropTarget | null): void {
  if (!drop) return;
  const node = docStore.doc.nodes[drop.id];
  const r = node ? worldRect(docStore.doc, drop.id) : null;
  if (!r || !node) return;
  const a = worldToScreen(vp, r.x, r.y);
  const b = worldToScreen(vp, r.x + r.width, r.y + r.height);
  const page = drop.kind === "page";
  g.save();
  g.fillStyle = page ? "rgba(79, 70, 229, 0.04)" : "rgba(79, 70, 229, 0.07)";
  g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  g.setLineDash([6, 4]);
  g.strokeStyle = "#4f46e5";
  g.lineWidth = page ? 2 : 1.5;
  g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
  g.setLineDash([]);

  const label = page ? "移入页面" : node.type === "component" ? "移入组件" : "移入画板";
  g.font = "11px 'Geist Variable', 'PingFang SC', sans-serif";
  g.textAlign = "left";
  g.textBaseline = "middle";
  const tw = g.measureText(label).width;
  const bw = tw + 14;
  const bh = 18;
  const bx = a.x + 8;
  const by = a.y + 8;
  (g as unknown as { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(bx, by, bw, bh, 4);
  g.fillStyle = "#4f46e5";
  g.fill();
  g.fillStyle = "#ffffff";
  g.fillText(label, bx + 7, by + bh / 2 + 0.5);
  g.restore();
}
