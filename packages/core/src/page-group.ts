/**
 * 页面分组（PageGroup）：逻辑归组画板（用于版本归档、多端布局隔离等场景）。
 *
 * 约定：
 * - 页面仍留在 `doc.rootIds`（`parentId: null`），只通过 `page.groupId` 关联分组；
 * - 分组不改变页面坐标系，也不影响整页缓存、视口剔除与组件区语义；
 * - `visible === false` 的分组跳过渲染与命中；`locked === true` 的分组禁止编辑组内节点。
 */

import type { DocNode, DocState, NodeId, PageGroup, PageGroupId, Rect } from "./model";
import { PAGE_GAP, getPages, nextPagePosition, unionRects, worldRect } from "./model";
import type { Command } from "./store";

export type PageGroupCommand = Extract<
  Command,
  { type: "pageGroup.create" | "pageGroup.update" | "pageGroup.delete" | "pageGroup.reorder" }
>;

/** 文档里的全部分组列表（返回新数组，避免调用方持有内部可变引用）。 */
export function getPageGroups(state: DocState): PageGroup[] {
  return state.pageGroups ? [...state.pageGroups] : [];
}

/** 按 id 查找分组。 */
export function getPageGroup(state: DocState, groupId: PageGroupId | undefined): PageGroup | undefined {
  if (!groupId) return undefined;
  return state.pageGroups?.find((g) => g.id === groupId);
}

/**
 * 列出属于某个分组的页面；`groupId === null` 返回未分组页面
 * （含指向不存在 groupId 的孤儿页，避免页面在左栏里凭空消失）。
 */
export function getPagesInGroup(state: DocState, groupId: PageGroupId | null): DocNode[] {
  const pages = getPages(state);
  if (groupId === null) {
    const valid = new Set(getPageGroups(state).map((g) => g.id));
    return pages.filter((p) => !p.groupId || !valid.has(p.groupId));
  }
  return pages.filter((p) => p.groupId === groupId);
}

/** 页面是否因所属分组隐藏而不可见。 */
export function isPageVisibleByGroup(state: DocState, page: DocNode): boolean {
  if (page.type !== "page") return true;
  const group = getPageGroup(state, page.groupId);
  return group ? group.visible !== false : true;
}

/** 页面是否因所属分组锁定而不可编辑。 */
export function isPageLockedByGroup(state: DocState, page: DocNode): boolean {
  if (page.type !== "page") return false;
  const group = getPageGroup(state, page.groupId);
  return group?.locked === true;
}

/** 文档里所有当前可见（所属分组未隐藏）的页面。 */
export function getVisiblePages(state: DocState): DocNode[] {
  return getPages(state).filter((p) => isPageVisibleByGroup(state, p));
}

/** 生成不重复的分组默认名："分组 N"；界面可传本地化前缀。 */
export function nextGroupName(state: DocState, prefix = "分组"): string {
  const used = new Set(getPageGroups(state).map((g) => g.name));
  let n = getPageGroups(state).length + 1;
  while (used.has(`${prefix} ${n}`)) n += 1;
  return `${prefix} ${n}`;
}

/** 组内新建页面的摆放位置：该组最右页面右侧，无同组页面时退回全文档排布。 */
export function nextPagePositionInGroup(state: DocState, groupId?: PageGroupId): { x: number; y: number } {
  if (!groupId) return nextPagePosition(state);
  const pages = getPagesInGroup(state, groupId);
  if (pages.length === 0) return nextPagePosition(state);
  const right = Math.max(...pages.map((p) => p.x + p.width));
  const top = Math.min(...pages.map((p) => p.y));
  return { x: right + PAGE_GAP, y: top };
}

/** 分组内所有页面的世界坐标并集包围盒（空组返回 null）。 */
export function groupBounds(state: DocState, groupId: PageGroupId): Rect | null {
  const rects = getPagesInGroup(state, groupId)
    .map((p) => worldRect(state, p.id))
    .filter((r): r is Rect => Boolean(r));
  return unionRects(rects);
}

function cloneGroup(group: PageGroup): PageGroup {
  return {
    ...group,
    ...(group.defaultPageSize ? { defaultPageSize: { ...group.defaultPageSize } } : {}),
    ...(group.meta ? { meta: { ...group.meta } } : {}),
  };
}

/** 校验分组字段合法性（用于前置校验与 applyOne 兜底）。 */
export function validatePageGroupCommand(
  state: DocState,
  cmd: Extract<
    Command,
    { type: "pageGroup.create" | "pageGroup.update" | "pageGroup.delete" | "pageGroup.reorder" | "pageGroup.assignPages" }
  >,
): void {
  const groups = getPageGroups(state);
  switch (cmd.type) {
    case "pageGroup.create": {
      const { group, pageIds } = cmd.params;
      if (!group.id || !group.id.trim()) throw new Error("分组 ID 不能为空");
      if (!group.name || !group.name.trim()) throw new Error("分组名称不能为空");
      if (groups.some((g) => g.id === group.id)) throw new Error(`分组 ${group.id} 已存在`);
      if (pageIds) {
        for (const pid of pageIds) {
          const node = state.nodes[pid];
          if (!node || node.type !== "page") throw new Error(`节点 ${pid} 不是页面，无法加入分组`);
        }
      }
      break;
    }
    case "pageGroup.update": {
      const target = groups.find((g) => g.id === cmd.params.groupId);
      if (!target) throw new Error(`分组 ${cmd.params.groupId} 不存在`);
      if (cmd.params.patch.name !== undefined && !cmd.params.patch.name.trim()) {
        throw new Error("分组名称不能为空");
      }
      break;
    }
    case "pageGroup.delete": {
      if (!groups.some((g) => g.id === cmd.params.groupId)) {
        throw new Error(`分组 ${cmd.params.groupId} 不存在`);
      }
      break;
    }
    case "pageGroup.reorder": {
      if (!groups.some((g) => g.id === cmd.params.groupId)) {
        throw new Error(`分组 ${cmd.params.groupId} 不存在`);
      }
      break;
    }
    case "pageGroup.assignPages": {
      const { pageIds, groupId } = cmd.params;
      if (groupId !== null && !groups.some((g) => g.id === groupId)) {
        throw new Error(`分组 ${groupId} 不存在`);
      }
      for (const pid of pageIds) {
        const node = state.nodes[pid];
        if (!node || node.type !== "page") throw new Error(`节点 ${pid} 不是页面，无法归入分组`);
      }
      break;
    }
  }
}

/**
 * 展开复合分组命令为原子命令序列：
 * - `pageGroup.create` 带 `pageIds` → 先建组，再逐页更新 `groupId`
 * - `pageGroup.delete` → 按 `mode` 解散（清 `groupId`）或删页（走 `node.delete` 自动清链接），再删空组
 * - `pageGroup.assignPages` → 逐页 `node.update({ groupId })`（撤销自动按每页旧组还原）
 */
export function expandPageGroupCommand(
  state: DocState,
  cmd: Extract<Command, { type: "pageGroup.create" | "pageGroup.delete" | "pageGroup.assignPages" }>,
): Command[] {
  switch (cmd.type) {
    case "pageGroup.create": {
      const { group, index, pageIds } = cmd.params;
      const out: Command[] = [{ type: "pageGroup.create", params: { group: cloneGroup(group), index } }];
      if (pageIds && pageIds.length > 0) {
        for (const pageId of pageIds) {
          out.push({ type: "node.update", params: { nodeId: pageId, patch: { groupId: group.id } } });
        }
      }
      return out;
    }
    case "pageGroup.delete": {
      const { groupId, mode = "ungroup" } = cmd.params;
      const pages = getPagesInGroup(state, groupId);
      const out: Command[] = [];
      if (mode === "deletePages") {
        for (const page of pages) {
          out.push({ type: "node.delete", params: { nodeId: page.id } });
        }
      } else {
        for (const page of pages) {
          out.push({ type: "node.update", params: { nodeId: page.id, patch: { groupId: undefined } } });
        }
      }
      out.push({ type: "pageGroup.delete", params: { groupId } });
      return out;
    }
    case "pageGroup.assignPages": {
      const { pageIds, groupId } = cmd.params;
      return pageIds.map((pageId) => ({
        type: "node.update" as const,
        params: { nodeId: pageId, patch: { groupId: groupId ?? undefined } },
      }));
    }
  }
}

/** 应用一条原子分组命令，返回撤销它所需的逆命令。 */
export function applyPageGroupCommand(
  state: DocState,
  cmd: PageGroupCommand,
  changed: Set<NodeId>,
): { cmd: Command } {
  if (!state.pageGroups) state.pageGroups = [];
  const groups = state.pageGroups;

  switch (cmd.type) {
    case "pageGroup.create": {
      const group = cloneGroup(cmd.params.group);
      const idx = cmd.params.index;
      if (idx === undefined || idx < 0 || idx > groups.length) groups.push(group);
      else groups.splice(idx, 0, group);
      changed.add("__doc__" as NodeId);
      return { cmd: { type: "pageGroup.delete", params: { groupId: group.id } } };
    }
    case "pageGroup.update": {
      const { groupId, patch } = cmd.params;
      const target = groups.find((g) => g.id === groupId);
      if (!target) throw new Error(`分组 ${groupId} 不存在`);
      const prev: Partial<Omit<PageGroup, "id">> = {};
      for (const key of Object.keys(patch) as (keyof Omit<PageGroup, "id">)[]) {
        const prevVal = target[key];
        (prev as Record<string, unknown>)[key] =
          prevVal && typeof prevVal === "object" ? { ...prevVal } : prevVal;
        const nextVal = patch[key];
        if (nextVal === undefined) {
          delete target[key];
        } else {
          (target as unknown as Record<string, unknown>)[key] =
            typeof nextVal === "object" ? { ...nextVal } : nextVal;
        }
      }
      changed.add("__doc__" as NodeId);
      for (const page of getPagesInGroup(state, groupId)) changed.add(page.id);
      return { cmd: { type: "pageGroup.update", params: { groupId, patch: prev } } };
    }
    case "pageGroup.delete": {
      const idx = groups.findIndex((g) => g.id === cmd.params.groupId);
      if (idx < 0) throw new Error(`分组 ${cmd.params.groupId} 不存在`);
      const [removed] = groups.splice(idx, 1);
      changed.add("__doc__" as NodeId);
      return { cmd: { type: "pageGroup.create", params: { group: cloneGroup(removed), index: idx } } };
    }
    case "pageGroup.reorder": {
      const from = groups.findIndex((g) => g.id === cmd.params.groupId);
      if (from < 0) throw new Error(`分组 ${cmd.params.groupId} 不存在`);
      const [moved] = groups.splice(from, 1);
      const to = Math.max(0, Math.min(groups.length, cmd.params.index));
      groups.splice(to, 0, moved);
      changed.add("__doc__" as NodeId);
      return { cmd: { type: "pageGroup.reorder", params: { groupId: moved.id, index: from } } };
    }
  }
}
