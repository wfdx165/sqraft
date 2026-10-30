/**
 * 删除选中：跳过页面与锁定子树，并退出该节点的路径编辑。
 * 核心层还会再兜底一次，这里负责不产生无意义的失败命令。
 */
import type { NodeId } from "@sqraft/core";
import { dispatch, docStore, select, ui } from "../store";
import { isLocked } from "./hit";
import type { PenState } from "./pen";

export function deleteSelection(pen: PenState): void {
  const ids = ui.selection.filter(
    (id: NodeId) => docStore.doc.nodes[id]?.type !== "page" && !isLocked(id),
  );
  if (ids.length === 0) return;
  if (pen.pathEdit && ids.includes(pen.pathEdit.id)) {
    pen.pathEdit = null;
    pen.vectorDrag = null;
  }
  dispatch(
    ids.map((id) => ({ type: "node.delete" as const, params: { nodeId: id } })),
    "delete",
  );
  select(ui.selection.filter((s) => !ids.includes(s)));
}
