/**
 * 画布与左栏共用的右键菜单内容：页面一套、元素一套（规格见 ai-native-polish 票 17）。
 * 只读文档状态 + 调已有动作，不自己写文档。
 */
import type { DocNode, NodeId } from "@sqraft/core";
import { openContextMenu, type ContextMenuItem } from "./context-menu";
import { copySelectionAction } from "./canvas/node-clipboard";
import { canDeletePage, deletePage } from "./canvas/page-actions";
import { openExportFor } from "./export-actions";
import { keyOf } from "./shortcuts";
import { docStore, hooks, select, ui } from "./store";

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
  const page = docStore.doc.nodes[pageId];
  if (!page || page.type !== "page") return;
  ui.activePageId = pageId;
  ui.expandedPageId = pageId;
  select([pageId]);
  const items: ContextMenuItem[] = [
    {
      label: "适配该页",
      hint: keyOf("view.fit"),
      run: () => {
        ui.activePageId = pageId;
        hooks.fitActivePage();
      },
    },
    {
      label: "导出 PNG…",
      hint: keyOf("file.exportPng"),
      run: () => openExportFor({ pageId, name: page.name }),
    },
    { label: "重命名", hint: keyOf("edit.rename"), separator: true, run: () => hooks.startRenameOf(pageId) },
    {
      label: "删除页面",
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
  const targets = ids.length > 0 ? ids : [nodeId];
  const name = targets.length > 1 ? `${targets.length} 个图层` : node.name;
  const onlyOne = targets.length === 1;
  const items: ContextMenuItem[] = [
    { label: "复制", hint: keyOf("edit.copy"), run: () => void copySelectionAction() },
    { label: "复制为 PNG", hint: keyOf("edit.copyImage"), run: () => hooks.copySelectionPng() },
    {
      label: "导出 PNG…",
      hint: keyOf("file.exportPng"),
      // 主组件是文档根节点，没有所属页面：照样按选区导出（透明底）
      run: () => openExportFor({ pageId: pageId ?? undefined, nodeIds: targets, name }),
    },
    {
      label: "重命名",
      hint: keyOf("edit.rename"),
      separator: true,
      disabled: !onlyOne,
      run: () => hooks.startRenameOf(nodeId),
    },
    { label: "删除", hint: "Del", danger: true, run: () => hooks.deleteSelectionNow() },
  ];
  openContextMenu(position, items);
}
