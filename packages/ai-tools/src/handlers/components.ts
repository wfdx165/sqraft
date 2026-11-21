// 工具名直接分派；每个分支保持原实现，ctx 提供 store 与宿主能力。
import type { NodeId } from "../shared";
import { ensurePage, findComponentSet, findSlotByName, firstPageId, newId, variantValuesOf, walkSubtree } from "../shared";
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

/** `create_component_set` */
export const handleCreateComponentSet: Handler = async (ctx, args) => {
    const ids = Array.isArray(args.componentIds) ? args.componentIds.map(String) : [];
    if (ids.length < 2) throw new Error("componentIds 至少需要两个主组件");
    const setId = newId();
    ctx.store.apply({ type: "variant.combine", params: { nodeIds: ids, setId } }, "ai:variant");
    const set = ctx.store.doc.nodes[setId];
    if (!set) throw new Error("组件集合创建失败");
    return JSON.stringify({
      ok: true,
      setId,
      name: set.name,
      properties: (set.variantProperties ?? []).map((def) => ({ id: def.id, name: def.name, values: def.values })),
      variants: Object.entries(set.variantMap ?? {}).map(([key, componentId]) => ({ componentId, key })),
    });
};

/** `add_variant` */
export const handleAddVariant: Handler = async (ctx, args) => {
    const setId = String(args.setId);
    const set = ctx.store.doc.nodes[setId];
    if (!set || set.type !== "componentSet") throw new Error(`组件集合 ${setId} 不存在`);
    const sourceId = args.sourceComponentId ? String(args.sourceComponentId) : set.children[0];
    const source = sourceId ? ctx.store.doc.nodes[sourceId] : undefined;
    if (!source || source.type !== "component") throw new Error("源变体不存在");

    const rawValues = args.values;
    if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) {
      throw new Error("values 必须是对象");
    }
    // 缺省属性沿用源变体当前值
    const current = variantValuesOf(ctx.store.doc, set, source.id) ?? [];
    const values: Record<string, string> = {};
    (set.variantProperties ?? []).forEach((def, i) => {
      const input = (rawValues as Record<string, unknown>)[def.id] ?? (rawValues as Record<string, unknown>)[def.name];
      const value = input === undefined ? current[i] : String(input);
      if (!value) throw new Error(`属性「${def.name}」缺少值`);
      values[def.id] = value;
    });

    const idMap: Record<NodeId, NodeId> = {};
    walkSubtree(ctx.store.doc, source.id, (node) => {
      idMap[node.id] = newId();
    });
    const componentId = idMap[source.id];
    ctx.store.apply(
      {
        type: "variant.add",
        params: { setId, sourceComponentId: source.id, values, componentId, idMap },
      },
      "ai:variant",
    );
    return JSON.stringify({ ok: true, componentId, name: ctx.store.doc.nodes[componentId]?.name });
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

    // 命中组件集合的变体属性：切换变体，而不是普通组件属性
    const instance = ctx.store.doc.nodes[instanceId];
    if (instance?.type === "instance" && instance.componentId) {
      const set = findComponentSet(ctx.store.doc, instance.componentId);
      const def = set?.variantProperties?.find((entry) => entry.id === propertyId || entry.name === propertyId);
      if (def) {
        if (value === null) throw new Error("变体属性不能用 null 清除；请切换到其他值");
        ctx.store.apply(
          { type: "variant.set", params: { instanceId, values: { [def.id]: String(value) } } },
          "ai:variant",
        );
        return JSON.stringify({ ok: true, variant: String(value) });
      }
    }

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
