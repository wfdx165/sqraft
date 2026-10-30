/**
 * 页面级动作：删除页面（左栏页面行与画布右键菜单共用一套确认文案）。
 */
import { getPages, walkSubtree, type NodeId } from "@sqraft/core";
import { dispatch, docStore, hooks, ui } from "../store";

/** 至少留一页：只剩一页时禁止删除。 */
export function canDeletePage(): boolean {
  return getPages(docStore.doc).length > 1;
}

/** 删除页面及其全部图层；用户取消或只剩一页时返回 false。 */
export function deletePage(pageId: NodeId): boolean {
  const page = docStore.doc.nodes[pageId];
  if (!page || page.type !== "page" || !canDeletePage()) return false;
  let components = 0;
  walkSubtree(docStore.doc, pageId, (node) => {
    if (node.type === "component") components += 1;
  });
  const extra = components ? `页面内有 ${components} 个主组件，引用它们的实例会自动脱离。` : "";
  if (!window.confirm(`删除页面「${page.name}」及其全部图层？${extra}`)) return false;
  const wasActive = ui.activePageId === pageId;
  dispatch({ type: "node.delete", params: { nodeId: pageId } }, "delete-page");
  const nextId = docStore.doc.rootIds[0] ?? null;
  if (wasActive && nextId) {
    // 删掉的是当前页：切到剩下第一页并适配，别把视口留在已删除的位置
    hooks.activatePage(nextId);
  } else if (ui.expandedPageId === pageId) {
    ui.expandedPageId = nextId;
    hooks.requestRedraw();
  }
  return true;
}
