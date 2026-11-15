// 工具名直接分派；每个分支保持原实现，ctx 提供 store 与宿主能力。
import type { NodeId } from "../shared";
import { ensurePage, findSlotByName, firstPageId, newId } from "../shared";
import type { Handler } from "../types";

/** `create_instance` */
export const handleCreateInstance: Handler = async (ctx, args) => {
    const componentId = String(args.componentId);
    const master = ctx.store.doc.nodes[componentId];
    if (!master || master.type !== "component") throw new Error(`组件 ${componentId} 不存在`);
    // 空文档没有页面：先建一页再画（与人工"新建页面"同一套命令，仍是一次撤销）
    let parentId = (args.parentId as NodeId | undefined) ?? ctx.getActivePageId?.() ?? firstPageId(ctx.store.doc);
    if (!parentId && args.parentId === undefined) parentId = ensurePage(ctx.store, ctx.defaultName?.("page") ?? "页面");
    if (!parentId || !ctx.store.doc.nodes[parentId]) throw new Error("parentId 不存在");
    const nodeId = newId();
    ctx.store.apply(
      {
        type: "instance.create",
        params: {
          componentId,
          parentId,
          nodeId,
          x: Number(args.x ?? 0),
          y: Number(args.y ?? 0),
          name: args.name as string | undefined,
        },
      },
      "ai:instance",
    );
    return JSON.stringify({ ok: true, nodeId });
};

/** `define_property` */
export const handleDefineProperty: Handler = async (ctx, args) => {
    const componentId = String(args.componentId);
    const targetNodeId = String(args.targetNodeId);
    const type = String(args.type);
    if (type !== "text" && type !== "boolean" && type !== "instance") {
      throw new Error("type 必须是 text / boolean / instance");
    }
    const id = newId();
    ctx.store.apply(
      {
        type: "property.define",
        params: {
          componentId,
          targetMainId: targetNodeId,
          id,
          type,
          name: args.name as string | undefined,
        },
      },
      "ai:property",
    );
    const def = ctx.store.doc.nodes[componentId]?.propertyDefs?.find((d) => d.id === id);
    return JSON.stringify({ ok: true, propertyId: id, name: def?.name });
};

/** `set_instance_prop` */
export const handleSetInstanceProp: Handler = async (ctx, args) => {
    const instanceId = String(args.instanceId);
    const propertyId = String(args.propertyId);
    const value = args.value === undefined ? null : (args.value as string | boolean | null);
    ctx.store.apply(
      { type: "property.set", params: { instanceId, propertyId, value } },
      "ai:property",
    );
    return JSON.stringify({ ok: true });
};

/** `fill_slot` */
export const handleFillSlot: Handler = async (ctx, args) => {
    const instanceId = String(args.instanceId);
    const slotName = String(args.slotName);
    const slotId = findSlotByName(ctx.store, instanceId, slotName);
    if (!slotId) throw new Error(`实例里没有名为 "${slotName}" 的插槽`);
    const nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.map(String) : [];
    if (nodeIds.length === 0) throw new Error("nodeIds 不能为空");
    ctx.store.apply({ type: "slot.fill", params: { slotId, nodeIds } }, "ai:slot");
    return JSON.stringify({ ok: true, slotId });
};

/** `swap_instance` */
export const handleSwapInstance: Handler = async (ctx, args) => {
    const instanceId = String(args.instanceId);
    const componentId = String(args.componentId);
    ctx.store.apply({ type: "instance.swap", params: { instanceId, componentId } }, "ai:swap");
    return JSON.stringify({ ok: true });
};

/** `detach_instance` */
export const handleDetachInstance: Handler = async (ctx, args) => {
    const instanceId = String(args.instanceId);
    ctx.store.apply({ type: "component.detach", params: { instanceId } }, "ai:detach");
    return JSON.stringify({ ok: true });
};
