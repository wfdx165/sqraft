/**
 * 布尔运算 / 转路径的界面入口：快捷键、右键菜单与命令面板共用。
 * 命令与几何都在 core（`boolean.*` / `node.convertToPath`）；这里只负责选区与错误提示。
 */
import { newId, type BooleanOp } from "@sqraft/core";
import { dispatch, docStore, select, ui } from "../store";
import { localizeError } from "../errors";
import { showToast } from "../toast";

/** 结果 id 必须在命令创建前分配（不变式 2）。 */
function booleanCommandType(op: BooleanOp) {
  return `boolean.${op}` as
    | "boolean.union"
    | "boolean.subtract"
    | "boolean.intersect"
    | "boolean.exclude";
}

export function booleanSelection(op: BooleanOp): void {
  const ids = ui.selection.filter((id) => Boolean(docStore.doc.nodes[id]));
  if (ids.length < 2) return;
  const resultId = newId();
  try {
    dispatch({ type: booleanCommandType(op), params: { nodeIds: ids, resultId } }, `布尔：${op}`);
    if (docStore.doc.nodes[resultId]) select([resultId]);
  } catch (error) {
    showToast(localizeError(error), "error");
  }
}

export function convertSelectionToPath(): void {
  const ids = ui.selection.filter((id) => {
    const node = docStore.doc.nodes[id];
    return node?.type === "rect" || node?.type === "ellipse" || node?.type === "polygon" || node?.type === "line";
  });
  if (ids.length === 0) return;
  try {
    dispatch({ type: "node.convertToPath", params: { nodeIds: ids } }, "转为路径");
  } catch (error) {
    showToast(localizeError(error), "error");
  }
}
