/**
 * 只读信息层：悬停容器的子元素边界、选中量距、多选整体虚线框。
 *
 * 纯绘制，不改文档也不改选区；文档层（`drawDocument`）与导出/截图都不含这些内容。
 * 「手势/编辑态期间不画」统一由 `busy` 收口：拖动、框选、拖参考线、钢笔草稿、
 * 裁切、行内编辑、锚点编辑都算忙。
 */
import type { DocState, NodeId, Rect } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { boundsHandlePoints } from "./selection-bounds";
import { paintChildOutlines } from "./child-outlines";
import { drawGuides } from "./guides";
import { selectionSiblingGaps, showSelectionSpacing } from "./selection-spacing";

export interface InfoOverlayState {
  editing: boolean;
  /** 当前工具名（`select` 才画信息层） */
  tool: string;
  /** 有进行中的手势或行内编辑：信息层全部隐藏 */
  busy: boolean;
  doc: DocState;
  selection: readonly NodeId[];
  hoverContainerId: NodeId | null;
  /** 多选整体包围盒（世界坐标）；null = 不画多选虚线框 */
  multiBounds: Rect | null;
}

export function paintInfoOverlays(
  g: CanvasRenderingContext2D,
  vp: Viewport,
  state: InfoOverlayState,
): void {
  if (state.editing && state.tool === "select" && !state.busy) {
    paintChildOutlines(g, vp, state.hoverContainerId);
  }

  if (
    showSelectionSpacing({
      editing: state.editing,
      tool: state.tool,
      busy: state.busy,
      selectionCount: state.selection.length,
    })
  ) {
    drawGuides(g, vp, [], selectionSiblingGaps(state.doc, state.selection, { zoom: vp.zoom }));
  }

  if (!state.multiBounds) return;
  const bounds = state.multiBounds;
  const tl = worldToScreen(vp, bounds.x, bounds.y);
  const br = worldToScreen(vp, bounds.x + bounds.width, bounds.y + bounds.height);
  g.save();
  g.strokeStyle = "rgba(79, 70, 229, 0.7)";
  g.lineWidth = 1;
  g.setLineDash([4, 3]);
  g.strokeRect(tl.x + 0.5, tl.y + 0.5, Math.max(0, br.x - tl.x), Math.max(0, br.y - tl.y));
  g.setLineDash([]);
  g.fillStyle = "#ffffff";
  for (const [, hx, hy] of boundsHandlePoints(tl, br)) {
    g.beginPath();
    g.rect(hx - 3.5, hy - 3.5, 7, 7);
    g.fill();
    g.stroke();
  }
  g.restore();
}
