/**
 * 画布与左栏共用的右键菜单内容：页面一套、元素一套（规格见 ai-native-polish 票 17）。
 * 只读文档状态 + 调已有动作，不自己写文档。
 */
import { newId, type DocNode, type NodeId } from "@sqraft/core";
import { openContextMenu, type ContextMenuItem } from "./context-menu";
import { copySelectionAction } from "./canvas/node-clipboard";
import { canDeletePage, deletePage } from "./canvas/page-actions";
import { enterPresenter } from "./presenter";
import { keyOf } from "./shortcuts";
import { dispatch, docStore, hooks, select, ui } from "./store";
import { duplicateVariant } from "./variant-actions";
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

/** 元素/页面右键的 Copy as 子菜单：格式 × 倍率在点菜单时定死。 */
function copyAsItems(): ContextMenuItem[] {
  return [
    { label: t("objectMenu.copyPng1"), run: () => hooks.copySelectionAs("png", 1) },
    { label: t("objectMenu.copyPng2"), run: () => hooks.copySelectionAs("png", 2) },
    { label: t("objectMenu.copyPng4"), run: () => hooks.copySelectionAs("png", 4) },
    { label: t("objectMenu.copySvg"), run: () => hooks.copySelectionAs("svg", 1) },
  ];
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
      // 右键会先把该页设为活动页（openPageMenu 开头），所以这里与 ⌥⌘Enter 等价；
      // 若要"不改活动页直接演示某页"，需要单独的入口，别复用本菜单的副作用
      label: t("objectMenu.presentFrom"),
      hint: keyOf("view.present"),
      run: () => enterPresenter(pageId),
    },
    {
      // 页面选中时没有图层选区，复制回退成“整页带背景”，与 ⌘⇧C 一致
      label: t("objectMenu.copyAs"),
      hint: keyOf("edit.copyImage"),
      children: copyAsItems(),
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
    { label: t("objectMenu.copyAs"), hint: keyOf("edit.copyImage"), children: copyAsItems() },
    {
      label: t("common.rename"),
      hint: keyOf("edit.rename"),
      separator: true,
      disabled: !onlyOne,
      run: () => hooks.startRenameOf(nodeId),
    },
  ];

  // 2+ 根级主组件：组成组件集合（ADR-0038）
  const rootComponents = ids
    .map((id) => docStore.doc.nodes[id])
    .filter((entry): entry is DocNode => entry?.type === "component" && entry.parentId === null);
  if (rootComponents.length >= 2) {
    items.push({
      label: t("objectMenu.combineVariants"),
      separator: true,
      run: () => {
        const setId = newId();
        try {
          dispatch(
            { type: "variant.combine", params: { nodeIds: rootComponents.map((c) => c.id), setId } },
            "variant-combine",
          );
          select([setId]);
        } catch {
          /* 命名不合规等由命令层拒绝 */
        }
      },
    });
  }

  // 单个变体：复制出一个新变体（组合自动取空闲值，之后可改名）
  const single = ids.length === 1 ? docStore.doc.nodes[ids[0]] : null;
  const set = single?.parentId ? docStore.doc.nodes[single.parentId] : null;
  if (single?.type === "component" && set?.type === "componentSet") {
    items.push({
      label: t("objectMenu.addVariant"),
      run: () => duplicateVariant(set.id, single.id),
    });
  }

  items.push({ label: t("common.delete"), hint: "Del", danger: true, separator: true, run: () => hooks.deleteSelectionNow() });
  openContextMenu(position, items);
}
