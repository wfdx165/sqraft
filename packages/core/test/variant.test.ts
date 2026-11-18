import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, newId, type DocNode } from "../src/model";
import { DocStore } from "../src/store";
import { findComponentSet, variantKey, variantValuesOf } from "../src/variant";
import { planDuplicate } from "../src/duplicate";

function makeComponent(
  store: DocStore,
  name: string,
  opts: { x?: number; y?: number; text?: string } = {},
): DocNode {
  const component = createNode("component", {
    name,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width: 120,
    height: 48,
    style: { fill: { value: "#eeeeee" } },
  });
  store.apply({ type: "node.create", params: { nodes: [component], parentId: null } });
  const label = createNode("text", {
    name: "Label",
    text: opts.text ?? "Label",
    width: 100,
    height: 20,
    x: 10,
    y: 10,
    style: { fontSize: 14 },
  });
  store.apply({ type: "node.create", params: { nodes: [label], parentId: component.id } });
  return component;
}

function defineTextProperty(store: DocStore, component: DocNode, propertyId: string): string {
  const label = store.doc.nodes[component.children[0]];
  store.apply({
    type: "property.define",
    params: { componentId: component.id, targetMainId: label.id, id: propertyId, type: "text" },
  });
  return label.id;
}

function instantiate(store: DocStore, componentId: string, x = 400, y = 100): string {
  const pageId = store.doc.rootIds.find((id) => store.doc.nodes[id].type === "page")!;
  const instanceId = newId();
  store.apply({
    type: "instance.create",
    params: { componentId, parentId: pageId, nodeId: instanceId, x, y },
  });
  return instanceId;
}

function combine(store: DocStore, components: DocNode[]): string {
  const setId = newId();
  store.apply({ type: "variant.combine", params: { nodeIds: components.map((c) => c.id), setId } });
  return setId;
}

describe("组件集合与变体", () => {
  it("combine 解析 Property=Value、建根级集合并按横向排布变体", () => {
    const store = new DocStore(createDocWithPage());
    const small = makeComponent(store, "Size=S, Type=Primary", { x: 0, y: 0 });
    // 属性顺序可以不同：按第一件的顺序对齐
    const medium = makeComponent(store, "Type=Primary, Size=M", { x: 200, y: 0 });
    const setId = combine(store, [small, medium]);

    const set = store.doc.nodes[setId];
    expect(set.type).toBe("componentSet");
    expect(set.parentId).toBeNull();
    expect(store.doc.rootIds).toContain(setId);
    expect(set.variantProperties).toEqual([
      { id: "prop-1", name: "Size", values: ["S", "M"] },
      { id: "prop-2", name: "Type", values: ["Primary"] },
    ]);
    expect(set.variantMap).toEqual({
      [variantKey(["S", "Primary"])]: small.id,
      [variantKey(["M", "Primary"])]: medium.id,
    });
    expect(set.children).toEqual([small.id, medium.id]);
    expect(store.doc.nodes[small.id].parentId).toBe(setId);
    expect(store.doc.nodes[small.id].name).toBe("Size=S, Type=Primary");
    expect(store.doc.nodes[medium.id].name).toBe("Size=M, Type=Primary");

    store.undo();
    expect(store.doc.nodes[setId]).toBeUndefined();
    expect(store.doc.nodes[small.id].parentId).toBeNull();
  });

  it("名字不合规或组合重复时拒绝组成集合", () => {
    const store = new DocStore(createDocWithPage());
    const a = makeComponent(store, "按钮", { x: 0 });
    const b = makeComponent(store, "Size=M", { x: 200 });
    expect(() => combine(store, [a, b])).toThrow(/Property=Value/);

    const c = makeComponent(store, "Size=S", { x: 400 });
    const d = makeComponent(store, "Size=S", { x: 600 });
    expect(() => combine(store, [c, d])).toThrow(/组合重复/);
  });

  it("切换变体保留几何、文本属性值与同名覆盖", () => {
    const store = new DocStore(createDocWithPage());
    const small = makeComponent(store, "Size=S", { x: 0, text: "Small" });
    const medium = makeComponent(store, "Size=M", { x: 200, text: "Medium" });
    const smallLabel = defineTextProperty(store, small, "p1");
    defineTextProperty(store, medium, "p1");
    combine(store, [small, medium]);

    const instanceId = instantiate(store, small.id, 500, 120);
    store.apply({ type: "node.update", params: { nodeId: instanceId, patch: { width: 222, height: 55 } } });
    const clonedLabel = `${instanceId}:${smallLabel}`;
    store.apply({
      type: "node.update",
      params: { nodeId: clonedLabel, patch: { text: "Overridden" } },
    });
    store.apply({
      type: "property.set",
      params: { instanceId, propertyId: "p1", value: "Property text" },
    });
    store.apply({ type: "node.update", params: { nodeId: clonedLabel, patch: { x: 22 } } });

    store.apply({ type: "variant.set", params: { instanceId, values: { "prop-1": "M" } } });
    const instance = store.doc.nodes[instanceId];
    expect(instance.componentId).toBe(medium.id);
    expect(instance.width).toBe(222);
    expect(instance.height).toBe(55);
    expect(instance.propValues).toEqual({ p1: "Property text" });

    const newLabelId = store.doc.nodes[medium.children[0]].id;
    const next = store.doc.nodes[`${instanceId}:${newLabelId}`];
    expect(next.text).toBe("Property text");
    // 覆盖按图层名路径映射到新变体的母版节点
    expect(next.x).toBe(22);
    expect(instance.overrides?.[newLabelId]?.x).toBe(22);

    store.undo();
    expect(store.doc.nodes[instanceId].componentId).toBe(small.id);
  });

  it("不存在的组合无法切换", () => {
    const store = new DocStore(createDocWithPage());
    const small = makeComponent(store, "Size=S", { x: 0 });
    const medium = makeComponent(store, "Size=M", { x: 200 });
    combine(store, [small, medium]);
    const instanceId = instantiate(store, small.id);
    expect(() =>
      store.apply({ type: "variant.set", params: { instanceId, values: { "prop-1": "XL" } } }),
    ).toThrow(/没有值/);
  });

  it("add 复制现有变体并写入新组合；updateProperty 同步映射与名称", () => {
    const store = new DocStore(createDocWithPage());
    const small = makeComponent(store, "Size=S, Type=Primary", { x: 0 });
    const medium = makeComponent(store, "Size=M, Type=Primary", { x: 200 });
    const smallLabel = defineTextProperty(store, small, "p1");
    const setId = combine(store, [small, medium]);

    const componentId = newId();
    const cloneLabel = newId();
    const idMap: Record<string, string> = {};
    idMap[small.id] = componentId;
    idMap[smallLabel] = cloneLabel;
    store.apply({
      type: "variant.add",
      params: {
        setId,
        sourceComponentId: small.id,
        values: { "prop-1": "L", "prop-2": "Primary" },
        componentId,
        idMap,
      },
    });
    const set = store.doc.nodes[setId];
    expect(set.variantMap?.[variantKey(["L", "Primary"])]).toBe(componentId);
    expect(store.doc.nodes[componentId].name).toBe("Size=L, Type=Primary");
    expect(store.doc.nodes[componentId].propertyDefs).toEqual([
      { id: "p1", name: "Label", type: "text", targetMainId: cloneLabel },
    ]);

    store.apply({
      type: "variant.updateProperty",
      params: { setId, propertyId: "prop-1", renameValue: { from: "S", to: "Small" } },
    });
    const renamed = store.doc.nodes[setId];
    expect(renamed.variantMap?.[variantKey(["Small", "Primary"])]).toBe(small.id);
    expect(renamed.variantMap?.[variantKey(["S", "Primary"])]).toBeUndefined();
    expect(store.doc.nodes[small.id].name).toBe("Size=Small, Type=Primary");

    store.apply({
      type: "variant.updateProperty",
      params: { setId, propertyId: "prop-2", name: "Variant" },
    });
    expect(store.doc.nodes[small.id].name).toBe("Size=Small, Variant=Primary");
    expect(variantValuesOf(store.doc, store.doc.nodes[setId], small.id)).toEqual(["Small", "Primary"]);
  });

  it("有实例引用的变体不能删除；解除引用后可删除", () => {
    const store = new DocStore(createDocWithPage());
    const small = makeComponent(store, "Size=S", { x: 0 });
    const medium = makeComponent(store, "Size=M", { x: 200 });
    const setId = combine(store, [small, medium]);
    const instanceId = instantiate(store, medium.id);

    expect(() =>
      store.apply({ type: "variant.remove", params: { setId, componentId: medium.id } }),
    ).toThrow(/core.variant.inUse/);
    expect(() => store.apply({ type: "node.delete", params: { nodeId: medium.id } })).toThrow(
      /实例引用/,
    );

    store.apply({ type: "node.delete", params: { nodeId: instanceId } });
    store.apply({ type: "variant.remove", params: { setId, componentId: medium.id } });
    expect(store.doc.nodes[medium.id]).toBeUndefined();
    expect(store.doc.nodes[setId].variantMap?.[variantKey(["M"])]).toBeUndefined();
    expect(findComponentSet(store.doc, small.id)?.id).toBe(setId);
  });

  it("复制组件集合：整树可复制，映射指向新变体", () => {
    const store = new DocStore(createDocWithPage());
    const small = makeComponent(store, "Size=S", { x: 0 });
    const medium = makeComponent(store, "Size=M", { x: 200 });
    const setId = combine(store, [small, medium]);
    const plan = planDuplicate(store.doc, [setId], { dx: 0, dy: 300, makeId: newId });
    store.apply(plan.command);
    const cloneId = plan.rootIds[0];
    const clone = store.doc.nodes[cloneId];
    expect(clone.type).toBe("componentSet");
    expect(clone.parentId).toBeNull();
    const ids = Object.values(clone.variantMap ?? {});
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => store.doc.nodes[id]?.parentId === clone.id)).toBe(true);
    expect(new Set(ids)).not.toContain(small.id);
  });

  it("删除属性值：连带删除变体、清理值；有实例引用时整体拒绝", () => {
    const store = new DocStore(createDocWithPage());
    const small = makeComponent(store, "Size=S", { x: 0 });
    const medium = makeComponent(store, "Size=M", { x: 200 });
    const large = makeComponent(store, "Size=L", { x: 400 });
    const setId = combine(store, [small, medium, large]);

    const instanceId = instantiate(store, small.id);
    expect(() =>
      store.apply({
        type: "variant.removeValue",
        params: { setId, propertyId: "prop-1", value: "S" },
      }),
    ).toThrow(/core.variant.inUse/);

    store.apply({ type: "node.delete", params: { nodeId: instanceId } });
    store.apply({
      type: "variant.removeValue",
      params: { setId, propertyId: "prop-1", value: "S" },
    });
    expect(store.doc.nodes[small.id]).toBeUndefined();
    expect(store.doc.nodes[setId].variantProperties?.[0].values).toEqual(["M", "L"]);
    expect(store.doc.nodes[setId].variantMap?.[variantKey(["S"])]).toBeUndefined();
    expect(store.doc.nodes[medium.id]).toBeTruthy();
  });

  it("组件集合只接受已登记的变体：普通节点/未登记组件不能移进去", () => {
    const store = new DocStore(createDocWithPage());
    const small = makeComponent(store, "Size=S, Type=Primary", { x: 0 });
    const medium = makeComponent(store, "Size=M, Type=Primary", { x: 200 });
    const setId = combine(store, [small, medium]);
    const pageId = store.doc.rootIds.find((id) => store.doc.nodes[id].type === "page")!;

    const rect = createNode("rect", { name: "矩形" });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    expect(() => store.apply({ type: "node.reparent", params: { nodeId: rect.id, parentId: setId } })).toThrow(
      /组件集合/,
    );

    const loose = makeComponent(store, "Size=L, Type=Primary", { x: 400 });
    expect(() => store.apply({ type: "node.reparent", params: { nodeId: loose.id, parentId: setId } })).toThrow(
      /复制为新变体/,
    );

    // 已登记的变体可以在集合内调序
    expect(() =>
      store.apply({ type: "node.reparent", params: { nodeId: small.id, parentId: setId, index: 1 } }),
    ).not.toThrow();
  });

  it("组件集合只能作为根节点", () => {
    const store = new DocStore(createDocWithPage());
    const pageId = store.doc.rootIds[0];
    const set = createNode("componentSet", { name: "集合" });
    expect(() =>
      store.apply({ type: "node.create", params: { nodes: [set], parentId: pageId } }),
    ).toThrow(/根节点/);
  });
});
