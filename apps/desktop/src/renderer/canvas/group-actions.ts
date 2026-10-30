/**
 * 分组 / 解组：⌘G / ⌘⇧G。
 * 组的语义（并集尺寸、不裁剪、缩放组=缩放子节点）在 core 的 `node.group` 里。
 */
import { newId } from "@sqraft/core";
import { dispatch, docStore, select, ui } from "../store";
import { isLocked } from "./hit";

export function groupSelection(): void {
  const ids = ui.selection.filter((id) => {
    const node = docStore.doc.nodes[id];
    return !!node && node.type !== "page" && !isLocked(id);
  });
  if (ids.length === 0) return;
  const groupId = newId();
  dispatch({ type: "node.group", params: { nodeIds: ids, groupId } }, "分组");
  if (docStore.doc.nodes[groupId]) select([groupId]);
}

export function ungroupSelection(): void {
  const groups = ui.selection.filter((id) => {
    const node = docStore.doc.nodes[id];
    return node?.type === "group" && !isLocked(id);
  });
  if (groups.length === 0) return;
  dispatch(
    groups.map((nodeId) => ({ type: "node.ungroup" as const, params: { nodeId } })),
    "解组",
  );
  select([]);
}
