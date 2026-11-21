import { describe, expect, it } from "vitest";
import { call, createNode, setup, type ToolExecutor } from "./helpers";
import { tools } from "../src/tools";

async function makeRootComponent(run: ToolExecutor, name: string): Promise<string> {
  const res = await call(run, "create_node", { kind: "component", name, width: 100, height: 40 });
  return String(res.nodeId);
}

describe("AI 工具：组件集合与变体", () => {
  it("工具表包含 create_component_set / add_variant", () => {
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("create_component_set");
    expect(names).toContain("add_variant");
    expect(names).toHaveLength(35);
  });

  it("create_component_set 解析属性并可 add_variant / 切换实例", async () => {
    const { store, run } = setup();
    const small = await makeRootComponent(run, "Size=S, Type=Primary");
    const medium = await makeRootComponent(run, "Size=M, Type=Primary");

    const set = await call(run, "create_component_set", { componentIds: [small, medium] });
    const setId = String(set.setId);
    expect(store.doc.nodes[setId].type).toBe("componentSet");
    expect(set.properties).toEqual([
      { id: "prop-1", name: "Size", values: ["S", "M"] },
      { id: "prop-2", name: "Type", values: ["Primary"] },
    ]);

    const added = await call(run, "add_variant", {
      setId,
      sourceComponentId: small,
      values: { Size: "L", Type: "Primary" },
    });
    const componentId = String(added.componentId);
    expect(store.doc.nodes[componentId].name).toBe("Size=L, Type=Primary");
    expect(Object.values(store.doc.nodes[setId].variantMap ?? {})).toContain(componentId);

    const instance = await call(run, "create_instance", { componentId: small, x: 500, y: 100 });
    const instanceId = String(instance.nodeId);
    await call(run, "set_instance_prop", { instanceId, propertyId: "Size", value: "L" });
    expect(store.doc.nodes[instanceId].componentId).toBe(componentId);

    // 不存在的组合被拒绝
    await expect(
      run("set_instance_prop", { instanceId, propertyId: "Size", value: "XL" }),
    ).rejects.toThrow(/没有值/);
  });

  it("非主组件不能组成集合", async () => {
    const { store, run, pageId } = setup();
    const frame = createNode("frame", { name: "F", width: 10, height: 10 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    const other = await makeRootComponent(run, "Size=M");
    await expect(
      run("create_component_set", { componentIds: [frame.id, other] }),
    ).rejects.toThrow(/不是主组件/);
  });
});

describe("AI 工具：增量入参", () => {
  it("add_variant 缺省属性沿用源变体", async () => {
    const { store, run } = setup();
    const small = await makeRootComponent(run, "Size=S, Type=Primary");
    const medium = await makeRootComponent(run, "Size=M, Type=Primary");
    const set = await call(run, "create_component_set", { componentIds: [small, medium] });
    const added = await call(run, "add_variant", {
      setId: String(set.setId),
      sourceComponentId: small,
      values: { Size: "L" },
    });
    expect(store.doc.nodes[String(added.componentId)].name).toBe("Size=L, Type=Primary");
  });
});
