/**
 * 层级顺序（z-order）：只改同一父级内的绘制顺序，不换父级。
 * 换父级走画布拖拽或图层面板拖拽，这里只处理"上下挪一层 / 直接置顶置底"。
 */
import type { ReorderAction } from "@sqraft/core";
import { dispatch, docStore, ui } from "../store";
import { isLocked } from "./hit";

const LABELS: Record<ReorderAction, string> = {
  forward: "上移一层",
  backward: "下移一层",
  front: "置顶",
  back: "置底",
};

export function reorderSelection(action: ReorderAction): void {
  const ids = ui.selection.filter((id) => !!docStore.doc.nodes[id] && !isLocked(id));
  if (ids.length === 0) return;
  dispatch({ type: "node.reorder", params: { nodeIds: ids, action } }, LABELS[action]);
}
