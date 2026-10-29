/**
 * 选中框、缩放手柄、尺寸徽标与悬停文本边界。
 * 屏幕空间叠加层；不参与文档渲染。
 */
import { worldRect, type NodeId } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { docStore } from "../store";
import { handlePointsOfQuad, selectionQuad, selectionScreenRect, type MovePreview, type ResizePreview } from "./selection";

export interface SelectionOverlayOptions {
  selection: readonly NodeId[];
  editing: boolean;
  drag: MovePreview | null;
  resizePreview: ResizePreview | null;
  textEditId: NodeId | null;
  pathEditId: NodeId | null;
  hoverTextId: NodeId | null;
}

export function drawPulse(
  g: CanvasRenderingContext2D,
  vp: Viewport,
  id: NodeId,
  progress: number,
): void {
  const r = worldRect(docStore.doc, id);
  if (!r) return;
  const a = worldToScreen(vp, r.x, r.y);
  const b = worldToScreen(vp, r.x + r.width, r.y + r.height);
  const ease = 1 - (1 - progress) * (1 - progress);
  g.strokeStyle = `rgba(79, 70, 229, ${(1 - progress) * 0.95})`;
  g.lineWidth = 2.5;
  g.shadowColor = "rgba(79, 70, 229, 0.6)";
  g.shadowBlur = 18 * (1 - progress);
  const grow = ease * 6;
  g.strokeRect(a.x - grow, a.y - grow, b.x - a.x + grow * 2, b.y - a.y + grow * 2);
  g.shadowBlur = 0;
}

export function drawSelectionOverlay(
  g: CanvasRenderingContext2D,
  vp: Viewport,
  opts: SelectionOverlayOptions,
): void {
  for (const id of opts.selection) {
    const n = docStore.doc.nodes[id];
    if (!n) continue;
    // 行内编辑中的文本只用输入框表示边界
    if (opts.textEditId === id) continue;
    // 锚点编辑态由 drawPathEditing 接管（不画包围盒手柄与尺寸徽标）
    if (opts.pathEditId === id) continue;
    const rect = selectionScreenRect(vp, id, opts.resizePreview, opts.drag);
    const quad = selectionQuad(vp, id, opts.resizePreview, opts.drag);
    if (!rect || !quad) continue;
    const { x, y, width } = rect;

    g.strokeStyle = "#4f46e5";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < quad.length; i++) g.lineTo(quad[i].x, quad[i].y);
    g.closePath();
    g.stroke();

    if (opts.editing && opts.selection.length === 1 && n.type !== "text") {
      for (const [, hx, hy] of handlePointsOfQuad(quad)) {
        g.beginPath();
        g.rect(hx - 3, hy - 3, 6, 6);
        g.fillStyle = "#ffffff";
        g.fill();
        g.strokeStyle = "#4f46e5";
        g.lineWidth = 1.25;
        g.stroke();
      }
    }

    if (opts.selection.length === 1 && !(opts.drag?.mode === "move" && opts.drag.moved)) {
      // 拖动中隐藏尺寸徽标：间距标签正好落在对象上方，两者会叠在一起（尺寸看检查器或缩放时）
      const label = `${Math.round(opts.resizePreview && opts.resizePreview.id === id ? opts.resizePreview.width : n.width)} × ${
        Math.round(opts.resizePreview && opts.resizePreview.id === id ? opts.resizePreview.height : n.height)
      }`;
      g.font = "10.5px 'Geist Mono Variable', ui-monospace, monospace";
      const tw = g.measureText(label).width;
      const bw = tw + 14;
      const bh = 19;
      const bx = x + width / 2 - bw / 2;
      const by = y - bh - 8;
      g.beginPath();
      (g as unknown as { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(
        bx,
        by,
        bw,
        bh,
        5,
      );
      g.fillStyle = "#4f46e5";
      g.fill();
      g.fillStyle = "#ffffff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(label, bx + bw / 2, by + bh / 2 + 0.5);
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
    }
  }

  // 悬停文本：淡紫虚线边界（选中时由上面的实线框接管）
  if (
    opts.editing &&
    opts.hoverTextId &&
    !opts.selection.includes(opts.hoverTextId) &&
    !opts.textEditId
  ) {
    const r = worldRect(docStore.doc, opts.hoverTextId);
    if (r) {
      const a = worldToScreen(vp, r.x, r.y);
      const b = worldToScreen(vp, r.x + r.width, r.y + r.height);
      g.save();
      g.strokeStyle = "rgba(79, 70, 229, 0.45)";
      g.lineWidth = 1;
      g.setLineDash([4, 3]);
      g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
      g.restore();
    }
  }
}
