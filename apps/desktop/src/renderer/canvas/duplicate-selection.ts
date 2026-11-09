/**
 * 原地复制（`⌘D`）：副本落在原件上方 10px，选区切到副本。
 *
 * 页面与锁定子树不复制（与删除同一套过滤）；id 在命令创建前就分配好，
 * 展开阶段不再生成 id（命令必须确定性）。
 */
import { newId, planDuplicate } from "@sqraft/core";
import { dispatch, docStore, select, ui } from "../store";
import { isLocked } from "./hit";

export function duplicateSelection(): void {
  const ids = ui.selection.filter((id) => {
    const node = docStore.doc.nodes[id];
    return !!node && node.type !== "page" && !isLocked(id);
  });
  if (ids.length === 0) return;
  const plan = planDuplicate(docStore.doc, ids, { dx: 10, dy: 10, makeId: newId });
  if (plan.rootIds.length === 0) return;
  dispatch(plan.command, "原地复制");
  select(plan.rootIds);
}
