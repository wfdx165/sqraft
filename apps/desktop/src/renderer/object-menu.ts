/**
 * 画布与左栏共用的右键菜单内容：页面一套、元素一套（规格见 ai-native-polish 票 17）。
 * 只读文档状态 + 调已有动作，不自己写文档。
 */
import type { DocNode, NodeId } from "@sqraft/core";
import { openContextMenu, type ContextMenuItem } from "./context-menu";
import { copySelectionAction } from "./canvas/node-clipboard";
import { canDeletePage, deletePage } from "./canvas/page-actions";
import { keyOf } from "./shortcuts";
import { docStore, hooks, select, ui } from "./store";
import { t } from "./i18n";

/** 节点所属页面（页面才是 rootIds 里的那一层）。 */
function pageOf(nodeId: NodeId): NodeId | null {
  let cur: DocNode | undefined = docStore.doc.nodes[nodeId];
  while (cur) {
    if (cur.type === "page") return cur.id;
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  return null;
}

/** 右键页面（画布上的页面本体 / 左栏页面行）。 */
export function openPageMenu(pageId: NodeId, position: { x: number; y: number }): void {
  if (docStore.doc.nodes[pageId]?.type !== "page") return;
  ui.activePageId = pageId;
  ui.expandedPageId = pageId;
  select([pageId]);
  const items: ContextMenuItem[] = [
    {
      label: t("objectMenu.fitPage"),
      hint: keyOf("view.fit"),
      run: () => {
        ui.activePageId = pageId;
        hooks.fitActivePage();
      },
    },
    {
      // 页面选中时没有图层选区，复制路径回退成“整页 2× 带背景”，与 ⌘⇧C 一致
      label: t("objectMenu.copyPng"),
      hint: keyOf("edit.copyImage"),
      run: () => hooks.copySelectionPng(),
    },
    { label: t("common.rename"), hint: keyOf("edit.rename"), separator: true, run: () => hooks.startRenameOf(pageId) },
    {
      label: t("pages.delete"),
      danger: true,
      separator: true,
      disabled: !canDeletePage(),
      run: () => void deletePage(pageId),
    },
  ];
  openContextMenu(position, items);
}

/** 右键元素（画布上的图层 / 左栏图层行）：在选区里就作用于整个选区。 */
export function openNodeMenu(nodeId: NodeId, position: { x: number; y: number }): void {
  const node = docStore.doc.nodes[nodeId];
  if (!node || node.type === "page") return;
  const pageId = pageOf(nodeId);
  if (pageId) {
    if (ui.activePageId !== pageId) ui.activePageId = pageId;
    ui.expandedPageId = pageId;
  }
  // 多选框里右键：保持整个选区（对整组动手）；否则右键即选中该节点
  if (!ui.selection.includes(nodeId)) select([nodeId]);
  const ids = ui.selection.filter((id) => docStore.doc.nodes[id]);
  const onlyOne = ids.length === 1;
  const items: ContextMenuItem[] = [
    { label: t("common.copy"), hint: keyOf("edit.copy"), run: () => void copySelectionAction() },
    { label: t("objectMenu.copyPng"), hint: keyOf("edit.copyImage"), run: () => hooks.copySelectionPng() },
    {
      label: t("common.rename"),
      hint: keyOf("edit.rename"),
      separator: true,
      disabled: !onlyOne,
      run: () => hooks.startRenameOf(nodeId),
    },
    { label: t("common.delete"), hint: "Del", danger: true, run: () => hooks.deleteSelectionNow() },
  ];
  openContextMenu(position, items);
}
