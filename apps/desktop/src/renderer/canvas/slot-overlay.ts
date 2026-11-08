/**
 * 插槽相关的 UI 叠加层：空插槽占位、拖动投放高亮。
 * 只进画布叠加层，不进入文档渲染 / 导出 / AI 截图。
 */
import { worldRect, type NodeId } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { docStore } from "../store";
import { t } from "../i18n";
import { labelFont } from "../font-stack";

export function paintSlotPlaceholders(
  g: CanvasRenderingContext2D,
  vp: Viewport,
  activePageId: NodeId | null,
  mode: string,
): void {
  if (mode !== "edit" || !activePageId) return;
  const visit = (id: NodeId): void => {
    const node = docStore.doc.nodes[id];
    if (!node || !node.visible) return;
    if (node.type === "slot" && node.children.length === 0) {
      const r = worldRect(docStore.doc, node.id);
      if (r) {
        const a = worldToScreen(vp, r.x, r.y);
        const b = worldToScreen(vp, r.x + r.width, r.y + r.height);
        g.save();
        g.fillStyle = "rgba(79, 70, 229, 0.06)";
        g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        g.setLineDash([5, 4]);
        g.strokeStyle = "rgba(79, 70, 229, 0.55)";
        g.lineWidth = 1;
        g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
        g.setLineDash([]);
        g.fillStyle = "rgba(79, 70, 229, 0.85)";
        g.font = labelFont();
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(node.name, (a.x + b.x) / 2, (a.y + b.y) / 2);
        g.restore();
      }
    }
    for (const childId of node.children) visit(childId);
  };
  visit(activePageId);
}

/** 拖动经过插槽时的高亮与投放提示。 */
export function paintDropSlot(g: CanvasRenderingContext2D, vp: Viewport, slotId: NodeId | null): void {
  if (!slotId) return;
  const r = worldRect(docStore.doc, slotId);
  if (!r) return;
  const a = worldToScreen(vp, r.x, r.y);
  const b = worldToScreen(vp, r.x + r.width, r.y + r.height);
  g.save();
  g.fillStyle = "rgba(79, 70, 229, 0.10)";
  g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  g.setLineDash([6, 4]);
  g.strokeStyle = "#4f46e5";
  g.lineWidth = 1.5;
  g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
  g.setLineDash([]);
  g.fillStyle = "#4f46e5";
  g.font = labelFont();
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(t("canvas.fillSlot"), (a.x + b.x) / 2, (a.y + b.y) / 2);
  g.restore();
}
