import { describe, expect, it } from "vitest";
import { createEmptyDoc, createNode, DocStore, firstPageId } from "@sqraft/core";
import { makeExecutor, type ToolExecutor } from "../src/index";

/** 每个用例一份干净文档 + 执行器（getActivePageId 固定为第一页）。 */
function setup(): { store: DocStore; run: ToolExecutor; pageId: string } {
  const store = new DocStore(createEmptyDoc());
  const pageId = firstPageId(store.doc)!;
  const run = makeExecutor(store, async () => "", () => pageId);
  return { store, run, pageId };
}

async function call(run: ToolExecutor, name: string, args: Record<string, unknown> = {}) {
  return JSON.parse(await run(name, args)) as Record<string, unknown>;
}

describe("AI 工具：路径", () => {
  it("create_node 用父容器坐标建路径，节点框由包围盒推导", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_node", {
      kind: "path",
      points: [
        { x: 30, y: 40 },
        { x: 130, y: 40 },
        { x: 130, y: 90 },
      ],
    });
    const node = store.doc.nodes[res.nodeId as string];
    expect(node.type).toBe("path");
    expect(node.vector?.closed).toBe(false);
    expect(node.x).toBe(30);
    expect(node.y).toBe(40);
    expect(node.width).toBe(100);
    expect(node.height).toBe(50);
    expect(node.vector?.anchors[0]).toMatchObject({ x: 0, y: 0 });
    // 未给颜色时开放路径默认描边
    expect(node.style.stroke).toEqual({ token: "color/text" });
    expect(node.style.strokeWidth).toBe(2);
  });

  it("闭合路径默认填充，且至少 3 个锚点", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_node", {
      kind: "path",
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 50, y: 80 },
      ],
    });
    expect(store.doc.nodes[res.nodeId as string].style.fill).toEqual({ token: "color/primary" });
    await expect(
      run("create_node", {
        kind: "path",
        closed: true,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      }),
    ).rejects.toThrow(/闭合路径至少需要 3 个锚点/);
  });

  it("points 缺失或坐标非数值时拒绝", async () => {
    const { run } = setup();
    await expect(run("create_node", { kind: "path" })).rejects.toThrow(/必须提供 points/);
    await expect(
      run("create_node", { kind: "path", points: [{ x: 0, y: 0 }, { x: 10, y: Number.NaN }] }),
    ).rejects.toThrow(/x\/y 必须是数值/);
  });

  it("update_node 的 points 按节点位置换算成本地坐标，撤销可恢复", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", {
      kind: "path",
      points: [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ],
    });
    const id = created.nodeId as string;
    await call(run, "update_node", {
      nodeId: id,
      points: [
        { x: 100, y: 100 },
        { x: 100, y: 260 },
      ],
      closed: false,
    });
    expect(store.doc.nodes[id].vector?.anchors[1]).toMatchObject({ x: 0, y: 160 });
    store.undo();
    expect(store.doc.nodes[id].width).toBe(100);
    expect(store.doc.nodes[id].vector?.anchors[1]).toMatchObject({ x: 100, y: 0 });
  });

  it("points / closed 只适用于 path", async () => {
    const { run } = setup();
    const rect = await call(run, "create_node", { kind: "rect" });
    await expect(
      run("update_node", { nodeId: rect.nodeId, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }),
    ).rejects.toThrow(/points 仅适用于 path/);
    await expect(run("update_node", { nodeId: rect.nodeId, closed: true })).rejects.toThrow(/closed 仅适用于 path/);
  });

  it("read_document 回传 vector", async () => {
    const { run } = setup();
    const created = await call(run, "create_node", {
      kind: "path",
      points: [
        { x: 0, y: 0 },
        { x: 40, y: 40 },
      ],
    });
    const doc = await call(run, "read_document");
    const pages = doc.pages as Array<{ subtree: string }>;
    const flat = JSON.parse(pages[0].subtree) as Array<{ id: string; vector?: { anchors: unknown[] } }>;
    expect(flat.find((n) => n.id === created.nodeId)?.vector?.anchors).toHaveLength(2);
  });
});

describe("AI 工具：多边形", () => {
  it("sides 缺省为 3，按边数命名", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", { kind: "polygon", x: 10, y: 20, width: 120, height: 90 });
    const node = store.doc.nodes[created.nodeId as string];
    expect(node.type).toBe("polygon");
    expect(node.sides).toBe(3);
    expect(node.name).toBe("三角形");
    expect(node.style.fill).toEqual({ token: "color/primary" });
  });

  it("边数夹紧到 3–12，非 3 时叫多边形", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", { kind: "polygon", sides: 40 });
    expect(store.doc.nodes[created.nodeId as string].sides).toBe(12);
    expect(store.doc.nodes[created.nodeId as string].name).toBe("多边形");
    await call(run, "update_node", { nodeId: created.nodeId, sides: 5 });
    expect(store.doc.nodes[created.nodeId as string].sides).toBe(5);
  });

  it("sides 只适用于 polygon", async () => {
    const { run } = setup();
    await expect(run("create_node", { kind: "rect", sides: 5 })).rejects.toThrow(/sides 仅适用于 kind=polygon/);
    const rect = await call(run, "create_node", { kind: "rect" });
    await expect(run("update_node", { nodeId: rect.nodeId, sides: 4 })).rejects.toThrow(/sides 仅适用于 polygon/);
  });

  it("read_document 回传 sides", async () => {
    const { run } = setup();
    const created = await call(run, "create_node", { kind: "polygon", sides: 6 });
    const doc = await call(run, "read_document");
    const pages = doc.pages as Array<{ subtree: string }>;
    const flat = JSON.parse(pages[0].subtree) as Array<{ id: string; sides?: number }>;
    expect(flat.find((n) => n.id === created.nodeId)?.sides).toBe(6);
  });
});

describe("AI 工具：样式纪律", () => {
  it("画板缺省填充 color/surface（与 GUI 一致）", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", { kind: "frame" });
    expect(store.doc.nodes[created.nodeId as string].style.fill).toEqual({ token: "color/surface" });
  });

  it("新建画板 / 组件默认开启自动布局（纵向、gap 10、padding 10）", async () => {
    const { store, run } = setup();
    const frame = await call(run, "create_node", { kind: "frame" });
    const frameLayout = store.doc.nodes[frame.nodeId as string].layout;
    expect(frameLayout).toMatchObject({
      direction: "vertical",
      gap: 10,
      padding: { top: 10, right: 10, bottom: 10, left: 10 },
    });
    const component = await call(run, "create_node", { kind: "component", width: 120, height: 80 });
    expect(store.doc.nodes[component.nodeId as string].layout?.gap).toBe(10);

    // 显式给了 layout 的就按给的来
    const custom = await call(run, "create_node", { kind: "frame", layout: { direction: "horizontal", gap: 4 } });
    expect(store.doc.nodes[custom.nodeId as string].layout).toMatchObject({ direction: "horizontal", gap: 4 });

    // 非容器不写布局
    const rect = await call(run, "create_node", { kind: "rect" });
    expect(store.doc.nodes[rect.nodeId as string].layout).toBeUndefined();
  });

  it("字面量色值被拒绝，Token 引用通过", async () => {
    const { run } = setup();
    await expect(run("create_node", { kind: "rect", fillToken: "#ff0000" })).rejects.toThrow(/禁止使用字面量色值/);
    await expect(
      run("create_node", { kind: "path", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], strokeToken: "#ff0000" }),
    ).rejects.toThrow(/禁止使用字面量色值/);
    await expect(
      run("create_node", { kind: "rect", fillToken: "color/primary" }),
    ).resolves.toContain("nodeId");
  });

  it("只改描边时保留原有填充（style 整体替换但先展开旧值）", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", { kind: "rect", fillToken: "color/primary" });
    const id = created.nodeId as string;
    await call(run, "update_node", { nodeId: id, strokeToken: "color/text", strokeWidth: 3 });
    expect(store.doc.nodes[id].style.fill).toEqual({ token: "color/primary" });
    expect(store.doc.nodes[id].style.stroke).toEqual({ token: "color/text" });
    expect(store.doc.nodes[id].style.strokeWidth).toBe(3);
  });
});

describe("AI 工具：组件 / 插槽 / 实例", () => {
  it("create_node 支持 component/slot，create_instance 物化整棵子树", async () => {
    const { store, run, pageId } = setup();
    const comp = await call(run, "create_node", { kind: "component", width: 120, height: 80 });
    const compId = comp.nodeId as string;
    expect(store.doc.nodes[compId].type).toBe("component");
    expect(store.doc.nodes[compId].name).toBe("组件 1");

    await call(run, "create_node", { kind: "text", parentId: compId, text: "标题" });
    const slot = await call(run, "create_node", { kind: "slot", parentId: compId, name: "body" });
    const slotId = slot.nodeId as string;
    expect(store.doc.nodes[slotId].type).toBe("slot");
    expect(store.doc.nodes[slotId].name).toBe("body");

    const inst = await call(run, "create_instance", { componentId: compId, parentId: pageId, x: 10, y: 20 });
    const instId = inst.nodeId as string;
    const instNode = store.doc.nodes[instId];
    expect(instNode.type).toBe("instance");
    expect(instNode.componentId).toBe(compId);
    expect(instNode.children).toHaveLength(2);

    const doc = await call(run, "read_document");
    const flat = JSON.parse((doc.pages as Array<{ subtree: string }>)[0].subtree) as Array<Record<string, unknown>>;
    expect(flat.find((n) => n.id === compId)?.type).toBe("component");
    expect(flat.find((n) => n.id === slotId)?.type).toBe("slot");
    expect(flat.find((n) => n.id === instId)?.componentId).toBe(compId);
    expect(flat.find((n) => n.id === instId)?.children).toHaveLength(2);
  });

  it("read_document 回传 propertyDefs / propValues / overrides / slotFilled", async () => {
    const { store, run, pageId } = setup();
    const comp = await call(run, "create_node", { kind: "component", width: 120, height: 80 });
    const compId = comp.nodeId as string;
    const text = await call(run, "create_node", { kind: "text", parentId: compId, text: "标题" });
    const textId = text.nodeId as string;
    const slot = await call(run, "create_node", { kind: "slot", parentId: compId, name: "body" });
    const slotId = slot.nodeId as string;
    const inst = await call(run, "create_instance", { componentId: compId, parentId: pageId });
    const instId = inst.nodeId as string;

    const instNode = store.doc.nodes[instId];
    const textClone = instNode.children.find((id) => store.doc.nodes[id].mainId === textId)!;
    const slotClone = instNode.children.find((id) => store.doc.nodes[id].mainId === slotId)!;

    store.apply({
      type: "property.define",
      params: { componentId: compId, targetMainId: textId, id: "p1", type: "text" },
    });
    store.apply({ type: "property.set", params: { instanceId: instId, propertyId: "p1", value: "AI 标题" } });
    store.apply({ type: "node.update", params: { nodeId: instId, patch: { width: 200 } } });

    const user = createNode("rect", { name: "插槽内容", width: 20, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [user], parentId: pageId } });
    store.apply({ type: "slot.fill", params: { slotId: slotClone, nodeIds: [user.id] } });

    const doc = await call(run, "read_document");
    const flat = JSON.parse((doc.pages as Array<{ subtree: string }>)[0].subtree) as Array<Record<string, unknown>>;
    const compNode = flat.find((n) => n.id === compId)!;
    expect((compNode.propertyDefs as Array<{ id: string }>)[0].id).toBe("p1");
    const instance = flat.find((n) => n.id === instId)!;
    expect(instance.propValues).toMatchObject({ p1: "AI 标题" });
    expect(instance.overrides).toBeTruthy();
    expect(flat.find((n) => n.id === textClone)?.text).toBe("AI 标题");
    expect(flat.find((n) => n.id === slotClone)?.slotFilled).toBe(true);
  });


  it("create_instance 进入未填充插槽时填充插槽", async () => {
    const { store, run } = setup();
    const a = await call(run, "create_node", { kind: "component" });
    const slot = await call(run, "create_node", { kind: "slot", parentId: a.nodeId, name: "body" });
    const b = await call(run, "create_node", { kind: "component" });
    const inst = await call(run, "create_instance", { componentId: a.nodeId });
    const instNode = store.doc.nodes[inst.nodeId as string];
    const slotClone = instNode.children.find((id) => store.doc.nodes[id].mainId === slot.nodeId)!;
    const child = await call(run, "create_instance", { componentId: b.nodeId, parentId: slotClone });
    expect(store.doc.nodes[slotClone].slotFilled).toBe(true);
    expect(store.doc.nodes[slotClone].children).toEqual([child.nodeId]);
    expect(store.doc.nodes[child.nodeId as string].parentId).toBe(slotClone);
  });

  it("组件与插槽的创建约束", async () => {
    const { run, pageId } = setup();
    const frame = await call(run, "create_node", { kind: "frame" });
    await expect(
      run("create_node", { kind: "component", parentId: frame.nodeId }),
    ).rejects.toThrow(/页面顶层/);

    const comp = await call(run, "create_node", { kind: "component" });
    await expect(run("create_node", { kind: "slot", parentId: pageId, name: "body" })).rejects.toThrow(
      /主组件内/,
    );
    await expect(run("create_node", { kind: "slot", parentId: comp.nodeId })).rejects.toThrow(/name/);
    await call(run, "create_node", { kind: "slot", parentId: comp.nodeId, name: "body" });
    await expect(
      run("create_node", { kind: "slot", parentId: comp.nodeId, name: "body" }),
    ).rejects.toThrow(/已存在/);

    const inst = await call(run, "create_instance", { componentId: comp.nodeId });
    await expect(
      run("create_node", { kind: "slot", parentId: inst.nodeId, name: "footer" }),
    ).rejects.toThrow(/主组件内/);
  });
});

describe("AI 工具：属性 / 插槽 / 替换 / 脱离", () => {
  function flatOf(doc: Record<string, unknown>): Array<Record<string, unknown>> {
    return JSON.parse((doc.pages as Array<{ subtree: string }>)[0].subtree) as Array<Record<string, unknown>>;
  }

  it("define_property + set_instance_prop 读写文本属性", async () => {
    const { store, run } = setup();
    const comp = await call(run, "create_node", { kind: "component" });
    const compId = comp.nodeId as string;
    const text = await call(run, "create_node", { kind: "text", parentId: compId, name: "标题", text: "标题" });
    const textId = text.nodeId as string;
    const inst = await call(run, "create_instance", { componentId: compId });
    const instId = inst.nodeId as string;

    const prop = await call(run, "define_property", {
      componentId: compId,
      targetNodeId: textId,
      type: "text",
      name: "标题文案",
    });
    expect(prop.name).toBe("标题文案");

    await call(run, "set_instance_prop", { instanceId: instId, propertyId: prop.propertyId, value: "AI 标题" });
    let flat = flatOf(await call(run, "read_document"));
    const cloneId = store.doc.nodes[instId].children.find((id) => store.doc.nodes[id].mainId === textId)!;
    expect(flat.find((n) => n.id === cloneId)?.text).toBe("AI 标题");
    expect(flat.find((n) => n.id === instId)?.propValues).toMatchObject({ [prop.propertyId as string]: "AI 标题" });

    await call(run, "set_instance_prop", { instanceId: instId, propertyId: prop.propertyId, value: null });
    flat = flatOf(await call(run, "read_document"));
    expect(flat.find((n) => n.id === cloneId)?.text).toBe("标题");

    await expect(
      run("set_instance_prop", { instanceId: instId, propertyId: "nope", value: "x" }),
    ).rejects.toThrow(/属性不存在/);
  });

  it("fill_slot 按名字填充实例插槽", async () => {
    const { store, run, pageId } = setup();
    const comp = await call(run, "create_node", { kind: "component" });
    const compId = comp.nodeId as string;
    const slot = await call(run, "create_node", { kind: "slot", parentId: compId, name: "body" });
    const slotId = slot.nodeId as string;
    const inst = await call(run, "create_instance", { componentId: compId });
    const instId = inst.nodeId as string;
    const slotClone = store.doc.nodes[instId].children.find((id) => store.doc.nodes[id].mainId === slotId)!;

    const user = await call(run, "create_node", { kind: "rect", parentId: pageId, name: "内容" });
    await call(run, "fill_slot", { instanceId: instId, slotName: "body", nodeIds: [user.nodeId] });
    const flat = flatOf(await call(run, "read_document"));
    expect(flat.find((n) => n.id === slotClone)?.slotFilled).toBe(true);
    expect(flat.find((n) => n.id === user.nodeId)?.parentId).toBe(slotClone);

    await expect(
      run("fill_slot", { instanceId: instId, slotName: "nope", nodeIds: [user.nodeId] }),
    ).rejects.toThrow(/插槽/);
  });

  it("swap_instance 与 detach_instance", async () => {
    const { store, run } = setup();
    const a = await call(run, "create_node", { kind: "component", width: 100, height: 50 });
    const b = await call(run, "create_node", { kind: "component", width: 200, height: 90 });
    const inst = await call(run, "create_instance", { componentId: a.nodeId });
    const instId = inst.nodeId as string;

    await call(run, "swap_instance", { instanceId: instId, componentId: b.nodeId });
    expect(store.doc.nodes[instId].componentId).toBe(b.nodeId);
    expect(store.doc.nodes[instId].width).toBe(200);

    await call(run, "detach_instance", { instanceId: instId });
    expect(store.doc.nodes[instId].type).toBe("frame");
    expect(store.doc.nodes[instId].componentId).toBeUndefined();

    await expect(
      run("swap_instance", { instanceId: instId, componentId: "nope" }),
    ).rejects.toThrow(/实例不存在|目标组件不存在/);
  });

  it("update_node 编辑实例内部自动记覆盖，母版同步不覆盖它", async () => {
    const { store, run } = setup();
    const comp = await call(run, "create_node", { kind: "component" });
    const compId = comp.nodeId as string;
    const text = await call(run, "create_node", { kind: "text", parentId: compId, name: "标题", text: "标题" });
    const textId = text.nodeId as string;
    const inst = await call(run, "create_instance", { componentId: compId });
    const instId = inst.nodeId as string;
    const cloneId = store.doc.nodes[instId].children.find((id) => store.doc.nodes[id].mainId === textId)!;

    await call(run, "update_node", { nodeId: cloneId, text: "AI 覆盖" });
    let flat = flatOf(await call(run, "read_document"));
    expect(flat.find((n) => n.id === instId)?.overrides).toBeTruthy();

    await call(run, "update_node", { nodeId: textId, text: "母版新文案" });
    flat = flatOf(await call(run, "read_document"));
    expect(flat.find((n) => n.id === cloneId)?.text).toBe("AI 覆盖");
  });
});

describe("AI 工具：自动布局与排版", () => {
  it("create_node 的 layout 会立即参与求解", async () => {
    const { store, run } = setup();
    const frame = await call(run, "create_node", {
      kind: "frame",
      width: 300,
      height: 100,
      layout: { direction: "horizontal", gap: 10, padding: 5 },
    });
    const rect = await call(run, "create_node", {
      kind: "rect",
      parentId: frame.nodeId,
      width: 50,
      height: 20,
    });
    const child = store.doc.nodes[rect.nodeId as string];
    expect(child).toMatchObject({ x: 5, y: 5 });
  });

  it("update_node 支持旋转、锁定与文本排版字段", async () => {
    const { store, run } = setup();
    const text = await call(run, "create_node", { kind: "text", text: "Hello" });
    const id = text.nodeId as string;
    await call(run, "update_node", {
      nodeId: id,
      rotation: 15,
      opacity: 0.5,
      fontSize: 24,
      fontWeight: 700,
      textAlignment: "center",
      textAlign: "center",
      lineHeight: 32,
      lineHeightUnit: "px",
      letterSpacing: 2,
      textCase: "upper",
      textDecoration: "underline",
    });
    expect(store.doc.nodes[id]).toMatchObject({ rotation: 15, opacity: 0.5 });
    expect(store.doc.nodes[id].style).toMatchObject({
      fontSize: 24,
      fontWeight: 700,
      textAlign: "center",
      lineHeight: 32,
      lineHeightUnit: "px",
      letterSpacing: 2,
      textCase: "upper",
      textDecoration: "underline",
    });
  });

  it("锁定后 update_node 与 delete_node 被拒绝", async () => {
    const { store, run } = setup();
    const rect = await call(run, "create_node", { kind: "rect" });
    await call(run, "update_node", { nodeId: rect.nodeId, locked: true });
    expect(store.doc.nodes[rect.nodeId as string].locked).toBe(true);
    await expect(run("update_node", { nodeId: rect.nodeId, width: 10 })).rejects.toThrow(/锁定/);
    await expect(run("delete_node", { nodeId: rect.nodeId })).rejects.toThrow(/锁定/);
    await call(run, "update_node", { nodeId: rect.nodeId, locked: false });
    await call(run, "update_node", { nodeId: rect.nodeId, width: 10 });
    expect(store.doc.nodes[rect.nodeId as string].width).toBe(10);
  });

  it("文本自动尺寸使用宿主注入的测量函数", async () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = firstPageId(store.doc)!;
    const run = makeExecutor(store, async () => "", () => pageId, () => ({ width: 123, height: 45 }));
    const text = await call(run, "create_node", { kind: "text", text: "Hello" });
    expect(store.doc.nodes[text.nodeId as string]).toMatchObject({ width: 123, height: 45 });
  });
});

describe("AI 工具：节点效果", () => {
  it("create_node 写入投影与模糊，读文档能看到", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_node", {
      kind: "rect",
      width: 200,
      height: 120,
      fillToken: "color/primary",
      effects: [
        { type: "drop-shadow", x: 0, y: 6, blur: 18, spread: 2, fillToken: "color/text" },
        { type: "backdrop-blur", radius: 12 },
      ],
    });
    const node = store.doc.nodes[res.nodeId as string];
    expect(node.style.effects).toHaveLength(2);
    expect(node.style.effects?.[0]).toMatchObject({ type: "drop-shadow", blur: 18, color: { token: "color/text" } });
    expect(node.style.effects?.[1]).toMatchObject({ type: "backdrop-blur", radius: 12 });

    const doc = await call(run, "read_document");
    expect(JSON.stringify(doc)).toContain("backdrop-blur");
  });

  it("update_node 整体替换效果列表，传空数组即清空", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", {
      kind: "rect",
      effects: [{ type: "drop-shadow", fillToken: "color/text" }],
    });
    const nodeId = created.nodeId as string;
    expect(store.doc.nodes[nodeId].style.effects).toHaveLength(1);

    await call(run, "update_node", {
      nodeId,
      effects: [
        { type: "inner-shadow", fillToken: "color/text", blur: 4 },
        { type: "layer-blur", radius: 6 },
      ],
    });
    expect(store.doc.nodes[nodeId].style.effects?.map((e) => e.type)).toEqual(["inner-shadow", "layer-blur"]);

    await call(run, "update_node", { nodeId, effects: [] });
    expect(store.doc.nodes[nodeId].style.effects).toEqual([]);
  });

  it("阴影颜色必须引用存在的 Token，禁止字面量", async () => {
    const { run } = setup();
    await expect(
      run("create_node", { kind: "rect", effects: [{ type: "drop-shadow" }] }),
    ).rejects.toThrow(/fillToken/);
    await expect(
      run("create_node", { kind: "rect", effects: [{ type: "drop-shadow", fillToken: "color/nope" }] }),
    ).rejects.toThrow(/Token/);
  });

  it("未知效果类型被拒绝", async () => {
    const { run } = setup();
    await expect(
      run("create_node", { kind: "rect", effects: [{ type: "glow" }] }),
    ).rejects.toThrow(/未知的效果类型/);
  });
});

describe("AI 工具：文档级操作与截图区域", () => {
  it("document.new 交给宿主执行", async () => {
    const store = new DocStore(createEmptyDoc());
    const calls: string[] = [];
    const run = makeExecutor(store, async () => "", undefined, undefined, {
      newDocument: async () => {
        calls.push("new");
        return true;
      },
      openDocument: async () => true,
    });
    expect(await call(run, "document.new")).toEqual({ ok: true });
    expect(calls).toEqual(["new"]);
  });

  it("document.new 把用户取消如实回报", async () => {
    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "", undefined, undefined, {
      newDocument: async () => false,
      openDocument: async () => true,
    });
    expect(await call(run, "document.new")).toEqual({ ok: false, canceled: true });
  });

  it("document.open 把用户取消如实回报", async () => {
    const store = new DocStore(createEmptyDoc());
    let opened = 0;
    const run = makeExecutor(store, async () => "", undefined, undefined, {
      newDocument: async () => true,
      openDocument: async () => {
        opened += 1;
        return false;
      },
    });
    expect(await call(run, "document.open")).toEqual({ ok: false, canceled: true });
    expect(opened).toBe(1);
  });

  it("document.open 拒绝路径参数（文件必须由用户选择）", async () => {
    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "", undefined, undefined, {
      newDocument: async () => true,
      openDocument: async () => true,
    });
    await expect(run("document.open", { path: "/etc/passwd" })).rejects.toThrow(/不接受路径参数/);
  });

  it("没有宿主时文档类工具给出可读错误", async () => {
    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "");
    await expect(run("document.new", {})).rejects.toThrow(/不支持新建文档/);
  });

  it("screenshot 把区域交给宿主，并校验参数", async () => {
    const store = new DocStore(createEmptyDoc());
    const regions: unknown[] = [];
    const run = makeExecutor(store, async (region) => {
      regions.push(region);
      return "data:image/png;base64,AA";
    });
    const res = await call(run, "screenshot", { region: { x: 10, y: 20, width: 100, height: 50 } });
    expect(res.image).toBe("data:image/png;base64,AA");
    expect(regions[0]).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    await expect(run("screenshot", { region: { x: 0, y: 0, width: 0, height: 10 } })).rejects.toThrow(/宽高为正数/);
  });
});

describe("AI 工具：撤销粒度", () => {
  it("一次调用只产生一条撤销记录，撤销把整次调用撤干净", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_node", { kind: "frame", width: 200, height: 120 });
    expect(store.canUndo).toBe(true);
    expect(store.undoLabel).toContain("create_node");
    store.undo();
    expect(store.doc.nodes[res.nodeId as string]).toBeUndefined();
    expect(store.canUndo).toBe(false);
  });

  it("插入实例时物化出的整棵子树算一步", async () => {
    const { store, run } = setup();
    const component = await call(run, "create_node", { kind: "component", width: 100, height: 60 });
    const componentId = component.nodeId as string;
    await call(run, "create_node", { kind: "rect", parentId: componentId, width: 40, height: 40 });
    await call(run, "create_node", { kind: "text", parentId: componentId, text: "hi", width: 40, height: 20 });

    const before = Object.keys(store.doc.nodes).length;
    const instance = await call(run, "create_instance", { componentId });
    const after = Object.keys(store.doc.nodes).length;
    expect(after).toBeGreaterThan(before + 1); // 整棵子树被物化

    expect(store.undoLabel).toContain("create_instance");
    store.undo();
    expect(Object.keys(store.doc.nodes).length).toBe(before);
    expect(store.doc.nodes[instance.nodeId as string]).toBeUndefined();
  });
});
