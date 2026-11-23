// 页面分组 MCP 工具处理函数：create / update / delete / assign。
import type { NodeId, PageGroup, PageGroupId } from "../shared";
import { getPageGroup, getPagesInGroup, newGroupId, nextGroupName } from "../shared";
import type { Handler } from "../types";

function readDefaultPageSize(raw: unknown): { width: number; height: number } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") throw new Error("defaultPageSize 必须是 { width, height } 对象");
  const obj = raw as { width?: unknown; height?: unknown };
  const width = Number(obj.width);
  const height = Number(obj.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("defaultPageSize 的 width / height 必须是正数");
  }
  return { width, height };
}

/** `create_page_group` */
export const handleCreatePageGroup: Handler = async (ctx, args) => {
  const name =
    args.name === undefined
      ? nextGroupName(ctx.store.doc)
      : String(args.name).trim();
  if (!name) throw new Error("分组名称不能为空");
  const group: PageGroup = {
    id: newGroupId(),
    name,
    ...(typeof args.color === "string" && args.color.trim() ? { color: args.color.trim() } : {}),
    ...(typeof args.visible === "boolean" ? { visible: args.visible } : {}),
    ...(typeof args.locked === "boolean" ? { locked: args.locked } : {}),
    ...(args.defaultPageSize !== undefined ? { defaultPageSize: readDefaultPageSize(args.defaultPageSize) } : {}),
  };
  const pageIds = Array.isArray(args.pageIds) ? (args.pageIds as NodeId[]) : undefined;
  ctx.store.apply({ type: "pageGroup.create", params: { group, pageIds } }, "ai:create_page_group");
  return JSON.stringify({
    ok: true,
    groupId: group.id,
    name: group.name,
    pageCount: getPagesInGroup(ctx.store.doc, group.id).length,
  });
};

/** `update_page_group` */
export const handleUpdatePageGroup: Handler = async (ctx, args) => {
  const groupId = String(args.groupId ?? "").trim() as PageGroupId;
  if (!groupId) throw new Error("需要 groupId");
  if (!getPageGroup(ctx.store.doc, groupId)) throw new Error(`分组 ${groupId} 不存在`);
  const patch: Partial<Omit<PageGroup, "id">> = {};
  if (args.name !== undefined) {
    const name = String(args.name).trim();
    if (!name) throw new Error("分组名称不能为空");
    patch.name = name;
  }
  if (args.color !== undefined) {
    patch.color = args.color === null || args.color === "" ? undefined : String(args.color).trim();
  }
  if (typeof args.visible === "boolean") patch.visible = args.visible;
  if (typeof args.locked === "boolean") patch.locked = args.locked;
  if (args.defaultPageSize !== undefined) {
    patch.defaultPageSize = args.defaultPageSize === null ? undefined : readDefaultPageSize(args.defaultPageSize);
  }
  ctx.store.apply({ type: "pageGroup.update", params: { groupId, patch } }, "ai:update_page_group");
  const updated = getPageGroup(ctx.store.doc, groupId)!;
  return JSON.stringify({
    ok: true,
    groupId: updated.id,
    name: updated.name,
    visible: updated.visible !== false,
    locked: updated.locked === true,
    ...(updated.color ? { color: updated.color } : {}),
    ...(updated.defaultPageSize ? { defaultPageSize: updated.defaultPageSize } : {}),
  });
};

/** `delete_page_group` */
export const handleDeletePageGroup: Handler = async (ctx, args) => {
  const groupId = String(args.groupId ?? "").trim() as PageGroupId;
  if (!groupId) throw new Error("需要 groupId");
  const mode = args.mode === "deletePages" ? "deletePages" : "ungroup";
  ctx.store.apply({ type: "pageGroup.delete", params: { groupId, mode } }, "ai:delete_page_group");
  return JSON.stringify({ ok: true, groupId, mode });
};

/** `assign_pages_to_group` */
export const handleAssignPagesToGroup: Handler = async (ctx, args) => {
  if (!Array.isArray(args.pageIds) || args.pageIds.length === 0) {
    throw new Error("pageIds 必须是非空页面 id 数组");
  }
  const pageIds = args.pageIds.map((id) => String(id));
  const rawGroup = args.groupId;
  const groupId: PageGroupId | null =
    rawGroup === null || rawGroup === undefined || rawGroup === "" ? null : String(rawGroup).trim();
  ctx.store.apply({ type: "pageGroup.assignPages", params: { pageIds, groupId } }, "ai:assign_pages_to_group");
  return JSON.stringify({ ok: true, pageIds, groupId });
};
