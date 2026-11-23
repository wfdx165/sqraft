/**
 * 页面分组的桌面端操作：新建、组内建页、显隐、锁定、改名、归组、删除与右键菜单。
 * 逻辑从 PagesPanel.vue 抽离，与画布/右键菜单共用同一套命令分发。
 */
import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  createNode,
  getPageGroup,
  getPageGroups,
  getPages,
  getPagesInGroup,
  newGroupId,
  nextGroupName,
  nextPageName,
  nextPagePositionInGroup,
  type NodeId,
  type PageGroupId,
} from "@sqraft/core";
import { openContextMenu, type ContextMenuItem } from "../context-menu";
import { t } from "../i18n";
import { dispatch, docStore, hooks, ui } from "../store";
import { showToast } from "../toast";

const GROUP_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#06b6d4", "#8b5cf6"];

function nextGroupColor(): string {
  const count = getPageGroups(docStore.doc).length;
  return GROUP_COLORS[count % GROUP_COLORS.length];
}

/** 新建页面分组；可选同时将一批页面归入该分组。 */
export function createPageGroup(name?: string, pageIds?: NodeId[]): PageGroupId {
  const id = newGroupId();
  const groupName = (name ?? nextGroupName(docStore.doc, t("pageGroups.defaultName"))).trim();
  dispatch(
    {
      type: "pageGroup.create",
      params: {
        group: { id, name: groupName || nextGroupName(docStore.doc, t("pageGroups.defaultName")), color: nextGroupColor() },
        pageIds,
      },
    },
    "create-page-group",
  );
  delete ui.collapsedGroups[id];
  return id;
}

/** 在指定分组内新建一个页面，优先沿用分组默认尺寸并排在该组最右。 */
export function createPageInGroup(groupId: PageGroupId): void {
  const group = getPageGroup(docStore.doc, groupId);
  if (!group) return;
  if (group.locked) {
    showToast(t("pageGroups.lockedHint"));
    return;
  }
  const pos = nextPagePositionInGroup(docStore.doc, groupId);
  const node = createNode("page", {
    name: nextPageName(docStore.doc, t("node.page")),
    x: pos.x,
    y: pos.y,
    width: group.defaultPageSize?.width ?? DEFAULT_PAGE_WIDTH,
    height: group.defaultPageSize?.height ?? DEFAULT_PAGE_HEIGHT,
    groupId,
  });
  dispatch({ type: "node.create", params: { nodes: [node], parentId: null } }, "create-page");
  delete ui.collapsedGroups[groupId];
  if (group.visible === false) {
    dispatch({ type: "pageGroup.update", params: { groupId, patch: { visible: true } } }, "show-page-group");
  }
  hooks.activatePage(node.id);
}

/** 切换分组显隐：隐藏时跳过画布渲染与命中。 */
export function toggleGroupVisible(groupId: PageGroupId): void {
  const group = getPageGroup(docStore.doc, groupId);
  if (!group) return;
  const next = group.visible === false;
  dispatch({ type: "pageGroup.update", params: { groupId, patch: { visible: next } } }, "toggle-group-visible");
  hooks.requestRedraw();
}

/** 切换分组锁定：锁定时禁止编辑组内页面与节点。 */
export function toggleGroupLocked(groupId: PageGroupId): void {
  const group = getPageGroup(docStore.doc, groupId);
  if (!group) return;
  dispatch({ type: "pageGroup.update", params: { groupId, patch: { locked: !group.locked } } }, "toggle-group-locked");
}

/** 重命名分组。 */
export function renamePageGroup(groupId: PageGroupId, name: string): void {
  const trimmed = name.trim();
  const group = getPageGroup(docStore.doc, groupId);
  if (!group || !trimmed || trimmed === group.name) return;
  dispatch({ type: "pageGroup.update", params: { groupId, patch: { name: trimmed } } }, "rename-page-group");
}

/** 将单个页面归入分组（null = 移出到未分组）。 */
export function assignPageToGroup(pageId: NodeId, groupId: PageGroupId | null): void {
  assignPagesToGroup([pageId], groupId);
}

/** 批量将多个页面归入分组（null = 移出到未分组），单步撤销。 */
export function assignPagesToGroup(pageIds: readonly NodeId[], groupId: PageGroupId | null): void {
  const valid = pageIds.filter((id) => {
    const page = docStore.doc.nodes[id];
    return page?.type === "page" && (page.groupId ?? null) !== groupId;
  });
  if (valid.length === 0) return;
  try {
    dispatch({ type: "pageGroup.assignPages", params: { pageIds: valid, groupId } }, "assign-page-group");
    if (groupId) delete ui.collapsedGroups[groupId];
    hooks.requestRedraw();
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
}

/** 删除分组：ungroup 仅解散（保留页面），deletePages 连同组内页面一起删。 */
export function deletePageGroup(groupId: PageGroupId, mode: "ungroup" | "deletePages"): void {
  const group = getPageGroup(docStore.doc, groupId);
  if (!group) return;
  if (group.locked) {
    showToast(t("pageGroups.lockedHint"));
    return;
  }
  if (mode === "deletePages") {
    const groupPages = getPagesInGroup(docStore.doc, groupId);
    if (groupPages.length >= getPages(docStore.doc).length && groupPages.length > 0) {
      showToast(t("pageGroups.cannotDeleteAllPages"));
      return;
    }
  }
  dispatch({ type: "pageGroup.delete", params: { groupId, mode } }, "delete-page-group");
  delete ui.collapsedGroups[groupId];
  hooks.requestRedraw();
}

/** 分组行右键菜单。 */
export function openPageGroupMenu(
  groupId: PageGroupId,
  position: { x: number; y: number },
  onStartRename: () => void,
): void {
  const group = getPageGroup(docStore.doc, groupId);
  if (!group) return;
  const visible = group.visible !== false;
  const locked = group.locked === true;
  const groupPages = getPagesInGroup(docStore.doc, groupId);
  const canDeleteWithPages = !locked && (groupPages.length === 0 || groupPages.length < getPages(docStore.doc).length);
  const items: ContextMenuItem[] = [
    {
      label: t("pageGroups.addPage"),
      disabled: locked,
      run: () => createPageInGroup(groupId),
    },
    {
      label: t("common.rename"),
      separator: true,
      run: onStartRename,
    },
    {
      label: visible ? t("pageGroups.hide") : t("pageGroups.show"),
      run: () => toggleGroupVisible(groupId),
    },
    {
      label: locked ? t("pageGroups.unlock") : t("pageGroups.lock"),
      run: () => toggleGroupLocked(groupId),
    },
    {
      label: t("pageGroups.ungroup"),
      separator: true,
      disabled: locked,
      run: () => deletePageGroup(groupId, "ungroup"),
    },
    {
      label: t("pageGroups.deleteWithPages"),
      danger: true,
      disabled: !canDeleteWithPages,
      run: () => deletePageGroup(groupId, "deletePages"),
    },
  ];
  openContextMenu(position, items);
}
