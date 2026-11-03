import { describe, expect, it } from "vitest";
import { createDocWithPage, createEmptyDoc, createNode, DocStore, firstPageId } from "@sqraft/core";
import { makeExecutor, type ToolExecutor } from "../src/index";

/** 每个用例一份干净文档 + 执行器（getActivePageId 固定为第一页）。 */
function setup(): { store: DocStore; run: ToolExecutor; pageId: string } {
  const store = new DocStore(createDocWithPage());
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
    expect(node.style.stroke).toEqual({ value: "#1a1a1a" });
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
    expect(store.doc.nodes[res.nodeId as string].style.fill).toEqual({ value: "#3366ff" });
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
    expect(node.style.fill).toEqual({ value: "#3366ff" });
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
  it("画板缺省填充白色字面量（与 GUI 一致）", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", { kind: "frame" });
    expect(store.doc.nodes[created.nodeId as string].style.fill).toEqual({ value: "#ffffff" });
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

  it("字面量色值可用；引用不存在的 Token 仍报错", async () => {
    const { store, run } = setup();
    const rect = await call(run, "create_node", { kind: "rect", fill: "#ff0000" });
    expect(store.doc.nodes[rect.nodeId as string].style.fill).toEqual({ value: "#ff0000" });

    const path = await call(run, "create_node", {
      kind: "path",
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      stroke: "#00ff00",
    });
    expect(store.doc.nodes[path.nodeId as string].style.stroke).toEqual({ value: "#00ff00" });

    // Token 引用仍然校验存在性
    await expect(run("create_node", { kind: "rect", fillToken: "color/primary" })).rejects.toThrow(/不存在的 Token/);
  });

  it("只改描边时保留原有填充（style 整体替换但先展开旧值）", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", { kind: "rect", fill: "#123456" });
    const id = created.nodeId as string;
    await call(run, "update_node", { nodeId: id, stroke: "#abcdef", strokeWidth: 3 });
    expect(store.doc.nodes[id].style.fill).toEqual({ value: "#123456" });
    expect(store.doc.nodes[id].style.stroke).toEqual({ value: "#abcdef" });
    expect(store.doc.nodes[id].style.strokeWidth).toBe(3);
  });
});

describe("AI 工具：主组件在文档根节点", () => {
  it("create_node 省略坐标时把母版排到组件区", async () => {
    const { store, run } = setup();
    const first = await call(run, "create_node", { kind: "component", width: 200, height: 100 });
    const page = store.doc.nodes[firstPageId(store.doc)!];
    expect(store.doc.nodes[first.nodeId as string].parentId).toBeNull();
    expect(store.doc.nodes[first.nodeId as string].y).toBe(page.y + page.height + 160);

    const second = await call(run, "create_node", { kind: "component", width: 120, height: 80 });
    const a = store.doc.nodes[first.nodeId as string];
    const b = store.doc.nodes[second.nodeId as string];
    expect(b.y).toBe(a.y);
    expect(b.x).toBe(a.x + a.width + 160);
  });

  it("空文档里建母版不再顺手建页面", async () => {
    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "", () => null);
    const comp = await call(run, "create_node", { kind: "component" });
    expect(store.doc.nodes[comp.nodeId as string].parentId).toBeNull();
    expect(store.doc.rootIds).toEqual([comp.nodeId]);
    expect(store.doc.nodes[comp.nodeId as string]).toMatchObject({ x: 0, y: 0 });
  });

  it("显式 parentId: null 也按根节点处理", async () => {
    const { store, run } = setup();
    const comp = await call(run, "create_node", { kind: "component", parentId: null });
    const node = store.doc.nodes[comp.nodeId as string];
    expect(node.parentId).toBeNull();
    expect(store.doc.rootIds).toContain(node.id);
  });

  it("显式给 x/y 时按给定位置放", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_node", { kind: "component", x: 900, y: 1200 });
    expect(store.doc.nodes[res.nodeId as string]).toMatchObject({ x: 900, y: 1200, parentId: null });
  });

  it("read_document 默认给摘要，按需附母版子树", async () => {
    const { run } = setup();
    const comp = await call(run, "create_node", { kind: "component" });
    await call(run, "create_node", { kind: "rect", parentId: comp.nodeId as string });

    const lean = await call(run, "read_document");
    const summary = (lean.components as Array<Record<string, unknown>>)[0];
    expect(summary.componentId).toBe(comp.nodeId);
    expect(summary.subtree).toBeUndefined();

    const full = await call(run, "read_document", { includeComponentTrees: true });
    const withTree = (full.components as Array<{ subtree: string }>)[0];
    expect(JSON.parse(withTree.subtree)).toHaveLength(2);
  });

  it("move_node 是一次撤销（父级与 layoutAbsolute 一起回退）", async () => {
    const { store, run, pageId } = setup();
    const frame = await call(run, "create_node", { kind: "frame", x: 0, y: 600, width: 200, height: 200 });
    const rect = await call(run, "create_node", { kind: "rect", x: 10, y: 10, width: 20, height: 20 });
    expect(store.doc.nodes[rect.nodeId as string].parentId).toBe(pageId);

    // 画板带自动布局：absolute=true 会同时改父级与 layoutAbsolute（两条命令）
    await call(run, "move_node", { nodeId: rect.nodeId, parentId: frame.nodeId, absolute: true });
    expect(store.doc.nodes[rect.nodeId as string]).toMatchObject({
      parentId: frame.nodeId,
      layoutAbsolute: true,
    });

    // 一次撤销必须把两处都还原：没有被 transact 合并时会剩一半
    expect(store.undo()).toBe(true);
    expect(store.doc.nodes[rect.nodeId as string].parentId).toBe(pageId);
    expect(store.doc.nodes[rect.nodeId as string].layoutAbsolute).toBeFalsy();
  });

  it("move_node 换父级保持世界坐标，主组件与页面被拒绝", async () => {
    const { store, run, pageId } = setup();
    const frame = await call(run, "create_node", { kind: "frame", x: 40, y: 60, width: 300, height: 200 });
    const rect = await call(run, "create_node", { kind: "rect", x: 100, y: 120, width: 40, height: 20 });
    expect(store.doc.nodes[rect.nodeId as string].parentId).toBe(pageId);

    // 画板默认带自动布局：absolute=true 落成绝对定位，世界坐标不变
    await call(run, "move_node", { nodeId: rect.nodeId, parentId: frame.nodeId, absolute: true });
    const moved = store.doc.nodes[rect.nodeId as string];
    expect(moved.parentId).toBe(frame.nodeId);
    expect(moved.x).toBe(60);
    expect(moved.y).toBe(60);
    expect(moved.layoutAbsolute).toBe(true);

    const comp = await call(run, "create_node", { kind: "component" });
    await expect(run("move_node", { nodeId: comp.nodeId, parentId: pageId })).rejects.toThrow(/根节点/);
    await expect(run("move_node", { nodeId: pageId, parentId: frame.nodeId })).rejects.toThrow(/页面/);
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

    const doc = await call(run, "read_document", { includeComponentTrees: true });
    // 母版是文档根节点：不在页面树里，走 components 摘要 + 可选子树
    const components = doc.components as Array<{ componentId: string; subtree?: string }>;
    const master = components.find((c) => c.componentId === compId)!;
    const masterTree = JSON.parse(master.subtree!) as Array<Record<string, unknown>>;
    expect(masterTree.find((n) => n.id === compId)?.type).toBe("component");
    expect(masterTree.find((n) => n.id === slotId)?.type).toBe("slot");
    const flat = JSON.parse((doc.pages as Array<{ subtree: string }>)[0].subtree) as Array<Record<string, unknown>>;
    expect(flat.find((n) => n.id === compId)).toBeUndefined();
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
    const compNode = (doc.components as Array<{ componentId: string; propertyDefs?: Array<{ id: string }> }>).find(
      (c) => c.componentId === compId,
    )!;
    expect(compNode.propertyDefs![0].id).toBe("p1");
    const flat = JSON.parse((doc.pages as Array<{ subtree: string }>)[0].subtree) as Array<Record<string, unknown>>;
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
    ).rejects.toThrow(/根节点/);

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
    const store = new DocStore(createDocWithPage());
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
      fill: "#3366ff",
      effects: [
        { type: "drop-shadow", x: 0, y: 6, blur: 18, spread: 2, color: "#1a1a1a" },
        { type: "backdrop-blur", radius: 12 },
      ],
    });
    const node = store.doc.nodes[res.nodeId as string];
    expect(node.style.effects).toHaveLength(2);
    expect(node.style.effects?.[0]).toMatchObject({ type: "drop-shadow", blur: 18, color: { value: "#1a1a1a" } });
    expect(node.style.effects?.[1]).toMatchObject({ type: "backdrop-blur", radius: 12 });

    const doc = await call(run, "read_document");
    expect(JSON.stringify(doc)).toContain("backdrop-blur");
  });

  it("update_node 整体替换效果列表，传空数组即清空", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", {
      kind: "rect",
      effects: [{ type: "drop-shadow", color: "#1a1a1a" }],
    });
    const nodeId = created.nodeId as string;
    expect(store.doc.nodes[nodeId].style.effects).toHaveLength(1);

    await call(run, "update_node", {
      nodeId,
      effects: [
        { type: "inner-shadow", color: "#1a1a1a", blur: 4 },
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
    const store = new DocStore(createDocWithPage());
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
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "", undefined, undefined, {
      newDocument: async () => false,
      openDocument: async () => true,
    });
    expect(await call(run, "document.new")).toEqual({ ok: false, canceled: true });
  });

  it("document.open 把用户取消如实回报", async () => {
    const store = new DocStore(createDocWithPage());
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
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "", undefined, undefined, {
      newDocument: async () => true,
      openDocument: async () => true,
    });
    await expect(run("document.open", { path: "/etc/passwd" })).rejects.toThrow(/不接受路径参数/);
  });

  it("没有宿主时文档类工具给出可读错误", async () => {
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "");
    await expect(run("document.new", {})).rejects.toThrow(/不支持新建文档/);
  });

  it("app_info 返回宿主版本与当前格式版本", async () => {
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "", undefined, undefined, {
      newDocument: async () => true,
      openDocument: async () => true,
      appInfo: async () => ({ name: "Sqraft", version: "0.1.0", platform: "darwin" }),
    });
    const info = await call(run, "app_info");
    expect(info).toMatchObject({ name: "Sqraft", version: "0.1.0", platform: "darwin" });
    expect(typeof info.formatVersion).toBe("number");
  });

  it("app_info 在没有宿主元信息时明确报错", async () => {
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "", undefined, undefined, {
      newDocument: async () => true,
      openDocument: async () => true,
    });
    await expect(run("app_info", {})).rejects.toThrow(/不支持 app_info/);
  });

  it("screenshot 把区域交给宿主，并校验参数", async () => {
    const store = new DocStore(createDocWithPage());
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

describe("图片工具", () => {
  const PNG_BASE64 = "iVBORw0KGgo=";

  function host(calls: string[]) {
    return {
      newDocument: async () => true,
      openDocument: async () => true,
      addImage: async (data: string) => {
        calls.push(data);
        return { assetId: "asset-1", width: 640, height: 480 };
      },
    };
  }

  it("create_node kind=image 走宿主落资源，尺寸取原图", async () => {
    const store = new DocStore(createDocWithPage());
    const calls: string[] = [];
    const run = makeExecutor(store, async () => "", undefined, undefined, host(calls));
    const created = await call(run, "create_node", {
      kind: "image",
      image: { data: PNG_BASE64, mimeType: "image/png" },
    });
    const node = store.doc.nodes[created.nodeId as string];
    expect(node.type).toBe("image");
    expect(node.width).toBe(640);
    expect(node.height).toBe(480);
    expect(node.image).toEqual({
      assetId: "asset-1",
      naturalWidth: 640,
      naturalHeight: 480,
      crop: { x: 0, y: 0, width: 640, height: 480 },
    });
    expect(calls).toEqual([PNG_BASE64]);
  });

  it("超过 5MB 直接拒绝，不调宿主", async () => {
    const store = new DocStore(createDocWithPage());
    const calls: string[] = [];
    const run = makeExecutor(store, async () => "", undefined, undefined, host(calls));
    const huge = "A".repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3) + 8);
    await expect(call(run, "create_node", { kind: "image", image: { data: huge } })).rejects.toThrow(/5MB/);
    expect(calls).toEqual([]);
  });

  it("update_node 能改裁切与蒙版标记", async () => {
    const store = new DocStore(createDocWithPage());
    const calls: string[] = [];
    const run = makeExecutor(store, async () => "", undefined, undefined, host(calls));
    const created = await call(run, "create_node", { kind: "image", image: { data: PNG_BASE64 } });
    const nodeId = created.nodeId as string;
    await call(run, "update_node", { nodeId, crop: { x: 10, y: 20, width: 100, height: 80 } });
    expect(store.doc.nodes[nodeId].image?.crop).toEqual({ x: 10, y: 20, width: 100, height: 80 });

    await call(run, "update_node", { nodeId, mask: true });
    expect(store.doc.nodes[nodeId].isMask).toBe(true);
  });

  it("crop 用在非图片节点上给出可读错误", async () => {
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "");
    const rect = await call(run, "create_node", { kind: "rect" });
    await expect(call(run, "update_node", { nodeId: rect.nodeId, crop: { x: 0, y: 0 } })).rejects.toThrow(/图片节点/);
  });

  it("kind=image 支持远程链接：只存 URL，不调宿主、不落资源", async () => {
    const store = new DocStore(createDocWithPage());
    const calls: string[] = [];
    const run = makeExecutor(store, async () => "", undefined, undefined, host(calls));
    const created = await call(run, "create_node", {
      kind: "image",
      image: { url: "https://cdn.example.com/banner.png" },
    });
    const node = store.doc.nodes[created.nodeId as string];
    expect(node.image).toEqual({
      sourceUrl: "https://cdn.example.com/banner.png",
      naturalWidth: 0,
      naturalHeight: 0,
    });
    // 懒加载：尺寸未知时给个可用默认框，抓取后由 GUI 的「适应原尺寸」调整
    expect(node.width).toBe(100);
    expect(node.height).toBe(100);
    expect(calls).toEqual([]);
  });

  it("image 的 data 与 url 只能给一个，非 http(s) 地址拒绝", async () => {
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "");
    await expect(
      call(run, "create_node", { kind: "image", image: { data: PNG_BASE64, url: "https://a/b.png" } }),
    ).rejects.toThrow(/只能给一个/);
    await expect(call(run, "create_node", { kind: "image", image: { url: "file:///etc/passwd" } })).rejects.toThrow(
      /http/,
    );
    await expect(call(run, "create_node", { kind: "image", image: { url: "不是地址" } })).rejects.toThrow(/URL/);
  });

  it("update_node imageUrl 换源后裁切作废、尺寸归零", async () => {
    const store = new DocStore(createDocWithPage());
    const calls: string[] = [];
    const run = makeExecutor(store, async () => "", undefined, undefined, host(calls));
    const created = await call(run, "create_node", { kind: "image", image: { data: PNG_BASE64 } });
    const nodeId = created.nodeId as string;
    await call(run, "update_node", { nodeId, crop: { x: 10, y: 20, width: 100, height: 80 }, imageUrl: "https://a/b.jpg" });
    expect(store.doc.nodes[nodeId].image).toEqual({
      sourceUrl: "https://a/b.jpg",
      naturalWidth: 0,
      naturalHeight: 0,
    });
  });

  it("链接图未加载时改 crop 给出可读错误", async () => {
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "");
    const created = await call(run, "create_node", { kind: "image", image: { url: "https://a/b.png" } });
    await expect(
      call(run, "update_node", { nodeId: created.nodeId, crop: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toThrow(/还没加载/);
  });
});

describe("AI 工具：分组 / 排列 / 复制", () => {
  async function threeRects() {
    const { store, run, pageId } = setup();
    const ids: string[] = [];
    for (const x of [0, 100, 300]) {
      const node = createNode("rect", { parentId: pageId, x, y: 0, width: 10, height: 10 });
      store.apply({ type: "node.create", params: { nodes: [node], parentId: pageId } });
      ids.push(node.id);
    }
    return { store, run, pageId, ids };
  }

  it("group_nodes 返回新分组 id，一次调用一条撤销", async () => {
    const { store, run, ids } = await threeRects();
    const res = await call(run, "group_nodes", { nodeIds: ids, name: "卡片组" });
    const groupId = res.groupId as string;
    expect(store.doc.nodes[groupId].type).toBe("group");
    expect(store.doc.nodes[groupId].name).toBe("卡片组");
    expect(store.doc.nodes[groupId].children).toHaveLength(3);

    store.undo();
    expect(store.doc.nodes[groupId]).toBeUndefined();
  });

  it("arrange_nodes：对齐 / 分布 / 层级", async () => {
    const { store, run, ids } = await threeRects();
    await call(run, "arrange_nodes", { nodeIds: ids, action: "distribute-h" });
    expect(store.doc.nodes[ids[1]].x).toBe(150);

    await call(run, "arrange_nodes", { nodeIds: ids, action: "align-left" });
    for (const id of ids) expect(store.doc.nodes[id].x).toBe(0);

    await call(run, "arrange_nodes", { nodeIds: [ids[0]], action: "bring-to-front" });
    const page = store.doc.nodes[store.doc.nodes[ids[0]].parentId!];
    expect(page.children.at(-1)).toBe(ids[0]);
  });

  it("arrange_nodes：非法动作与 <3 个分布都报错", async () => {
    const { run, ids } = await threeRects();
    await expect(run("arrange_nodes", { nodeIds: ids, action: "spin" })).rejects.toThrow();
    await expect(run("arrange_nodes", { nodeIds: [ids[0], ids[1]], action: "distribute-h" })).rejects.toThrow();
  });

  it("duplicate_node 返回新根 id，并保留子树", async () => {
    const { store, run, pageId } = await threeRects();
    const res = await call(run, "duplicate_node", { nodeId: store.doc.nodes[pageId].children[0] });
    const copyId = (res.nodeIds as string[])[0];
    expect(store.doc.nodes[copyId]).toBeDefined();
    expect(store.doc.nodes[copyId].x).toBe(10);
  });
});

describe("AI 工具：空文档自动建页", () => {
  it("没有页面时 create_node 自动建页，且只占一条撤销", async () => {
    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "", () => null);

    const res = await call(run, "create_node", { kind: "rect", fill: "#ff0000" });
    expect(store.doc.rootIds).toHaveLength(1);
    const pageId = store.doc.rootIds[0];
    expect(store.doc.nodes[pageId].type).toBe("page");
    expect(store.doc.nodes[res.nodeId as string].parentId).toBe(pageId);

    store.undo();
    expect(store.doc.rootIds).toHaveLength(0);
    expect(store.doc.nodes[res.nodeId as string]).toBeUndefined();
  });

  it("显式传不存在的 parentId 仍然报错", async () => {
    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "", () => null);
    await expect(run("create_node", { kind: "rect", parentId: "missing" })).rejects.toThrow(/parentId/);
  });
});

describe("AI 工具：页面", () => {
  it("create_page 在空文档里默认叫页面 1、放在原点", async () => {
    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "", () => null);
    const res = await call(run, "create_page", {});
    expect(res).toMatchObject({ ok: true, name: "页面 1" });
    expect(store.doc.rootIds).toEqual([res.pageId]);
    expect(store.doc.nodes[res.pageId as string]).toMatchObject({
      type: "page",
      x: 0,
      y: 0,
      width: 1440,
      height: 1024,
    });
  });

  it("create_page 支持显式名字/位置/尺寸，第二页默认接在最右侧", async () => {
    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "", () => null);
    const first = await call(run, "create_page", { name: "登录", x: 50, y: 60, width: 800, height: 600 });
    expect(store.doc.nodes[first.pageId as string]).toMatchObject({
      name: "登录",
      x: 50,
      y: 60,
      width: 800,
      height: 600,
    });
    const second = await call(run, "create_page", {});
    expect(second.name).toBe("页面 2");
    // 最右侧（50 + 800）再留 160 的 PAGE_GAP，顶部与第一页对齐
    expect(store.doc.nodes[second.pageId as string]).toMatchObject({ x: 1010, y: 60 });
  });

  it("create_page 会切到新页（宿主实现 activatePage 时）", async () => {
    const store = new DocStore(createEmptyDoc());
    const activated: string[] = [];
    const run = makeExecutor(store, async () => "", () => null, undefined, {
      newDocument: async () => true,
      openDocument: async () => true,
      activatePage: (pageId) => activated.push(pageId),
    });
    const res = await call(run, "create_page", { name: "详情" });
    expect(activated).toEqual([res.pageId]);
  });

  it("create_page 拒绝空名与非正尺寸", async () => {
    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "", () => null);
    await expect(run("create_page", { name: "   " })).rejects.toThrow(/页面名/);
    await expect(run("create_page", { width: 0 })).rejects.toThrow(/正数/);
    await expect(run("create_page", { height: Number.NaN })).rejects.toThrow(/正数/);
  });

  it("create_page 一次调用一条撤销", async () => {
    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "", () => null);
    await run("create_page", { name: "一" });
    await run("create_page", { name: "二" });
    expect(store.doc.rootIds).toHaveLength(2);
    store.undo();
    expect(store.doc.rootIds).toHaveLength(1);
    expect(store.doc.nodes[store.doc.rootIds[0]].name).toBe("一");
  });

  it("update_node 可以改页面名与图层名", async () => {
    const { store, run, pageId } = setup();
    await run("update_node", { nodeId: pageId, name: "  首页  " });
    expect(store.doc.nodes[pageId].name).toBe("首页");

    const rect = await call(run, "create_node", { kind: "rect" });
    await run("update_node", { nodeId: rect.nodeId, name: "按钮" });
    expect(store.doc.nodes[rect.nodeId as string].name).toBe("按钮");

    await expect(run("update_node", { nodeId: pageId, name: "   " })).rejects.toThrow(/name/);
  });
});

describe("AI 工具：导出与布局检查", () => {
  it("export_png 校验倍率并交给宿主渲染", async () => {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const run = makeExecutor(store, async () => "", () => pageId, undefined, {
      newDocument: async () => true,
      openDocument: async () => true,
      exportPng: (request) => `data:image/png;base64,${request.scale}`,
    });

    const ok = await call(run, "export_png", { scale: 3 });
    expect(ok.image).toBe("data:image/png;base64,3");
    await expect(run("export_png", { scale: 9 })).rejects.toThrow(/scale/);
    await expect(run("export_png", { pageId: "missing" })).rejects.toThrow(/pageId/);
  });

  it("inspect_layout 返回世界坐标与布局参数", async () => {
    const { store, run, pageId } = setup();
    const frame = createNode("frame", { parentId: pageId, x: 100, y: 50, width: 200, height: 100 });
    const child = createNode("rect", { parentId: frame.id, x: 10, y: 20, width: 30, height: 40, layoutAbsolute: true });
    frame.children = [child.id];
    store.apply({ type: "node.create", params: { nodes: [frame, child], parentId: pageId } });

    const res = JSON.parse((await run("inspect_layout", { pageId })) as string) as {
      nodes: Array<Record<string, unknown>>;
    };
    const row = res.nodes.find((n) => n.id === child.id)!;
    expect(row).toMatchObject({ x: 110, y: 70, width: 30, height: 40, absolute: true });
  });

  it("inspect_layout 的 nodeIds 含整棵子树，重复的后代只输出一次", async () => {
    const { store, run, pageId } = setup();
    const frame = createNode("frame", { parentId: pageId, x: 0, y: 0, width: 100, height: 100 });
    const child = createNode("rect", { parentId: frame.id, x: 5, y: 5, width: 10, height: 10 });
    frame.children = [child.id];
    store.apply({ type: "node.create", params: { nodes: [frame, child], parentId: pageId } });

    const rows = async (nodeIds: string[]) => {
      const res = JSON.parse(await run("inspect_layout", { pageId, nodeIds })) as {
        nodes: Array<{ id: string; depth: number }>;
      };
      return res.nodes.map((n) => `${n.id}:${n.depth}`);
    };
    expect(await rows([frame.id])).toEqual([`${frame.id}:0`, `${child.id}:1`]);
    // 同时请求父与子：子作为后代只出现一次，depth 以根为准
    expect(await rows([frame.id, child.id])).toEqual([`${frame.id}:0`, `${child.id}:1`]);
  });
});

describe("AI 工具：设计 Token", () => {
  it("define_token 新增颜色/数字，同类型可覆盖", async () => {
    const { store, run } = setup();
    expect(await call(run, "define_token", { path: "color/brand", type: "color", value: "#3366ff" })).toMatchObject({
      ok: true,
      path: "color/brand",
    });
    expect(store.doc.tokens["color/brand"]).toEqual({ type: "color", value: "#3366ff" });

    await run("define_token", { path: "color/brand", type: "color", value: "rgba(0, 0, 0, 0.5)" });
    expect(store.doc.tokens["color/brand"]).toEqual({ type: "color", value: "rgba(0, 0, 0, 0.5)" });

    // 8 位 hex（带 alpha）也是合法颜色，应用自身的阴影默认色就用这种写法
    await run("define_token", { path: "color/overlay", type: "color", value: "#0f172a29" });
    expect(store.doc.tokens["color/overlay"]).toEqual({ type: "color", value: "#0f172a29" });

    await run("define_token", { path: "spacing/md", type: "number", value: 12 });
    expect(store.doc.tokens["spacing/md"]).toEqual({ type: "number", value: 12 });
  });

  it("define_token 拒绝非法路径 / 类型 / 取值 / 改类型", async () => {
    const { run } = setup();
    await expect(run("define_token", { path: "brand", type: "color", value: "#fff" })).rejects.toThrow(/路径/);
    await expect(run("define_token", { path: "color//x", type: "color", value: "#fff" })).rejects.toThrow(/路径/);
    await expect(run("define_token", { path: "color/x", type: "paint", value: "#fff" })).rejects.toThrow(/type/);
    await expect(run("define_token", { path: "color/x", type: "color", value: "red" })).rejects.toThrow(/颜色/);
    await expect(run("define_token", { path: "spacing/x", type: "number", value: "" })).rejects.toThrow(/数值/);
    await expect(run("define_token", { path: "spacing/x", type: "number", value: "Infinity" })).rejects.toThrow(/数值/);

    await run("define_token", { path: "color/x", type: "color", value: "#fff" });
    await expect(run("define_token", { path: "color/x", type: "number", value: 1 })).rejects.toThrow(/类型/);
  });

  it("rename_token 重命名后节点引用随动，撤销能整体恢复", async () => {
    const { store, run } = setup();
    await run("define_token", { path: "color/brand", type: "color", value: "#3366ff" });
    const created = await call(run, "create_node", { kind: "rect", fillToken: "color/brand" });
    const nodeId = created.nodeId as string;
    expect(store.doc.nodes[nodeId].style.fill).toEqual({ token: "color/brand" });

    await run("rename_token", { from: "color/brand", to: "color/primary" });
    expect(store.doc.tokens["color/brand"]).toBeUndefined();
    expect(store.doc.tokens["color/primary"]).toEqual({ type: "color", value: "#3366ff" });
    expect(store.doc.nodes[nodeId].style.fill).toEqual({ token: "color/primary" });

    store.undo();
    expect(store.doc.tokens["color/brand"]).toEqual({ type: "color", value: "#3366ff" });
    expect(store.doc.nodes[nodeId].style.fill).toEqual({ token: "color/brand" });
  });

  it("rename_token 拒绝不存在的源与已存在的目标", async () => {
    const { run } = setup();
    await run("define_token", { path: "color/a", type: "color", value: "#000" });
    await run("define_token", { path: "color/b", type: "color", value: "#fff" });
    await expect(run("rename_token", { from: "color/missing", to: "color/c" })).rejects.toThrow(/不存在/);
    await expect(run("rename_token", { from: "color/a", to: "color/b" })).rejects.toThrow(/已存在/);
    await expect(run("rename_token", { from: "color/a", to: "color/a" })).rejects.toThrow(/相同/);
  });

  it("define_token 是一条撤销", async () => {
    const { store, run } = setup();
    await run("define_token", { path: "color/one", type: "color", value: "#111111" });
    await run("define_token", { path: "color/two", type: "color", value: "#222222" });
    expect(Object.keys(store.doc.tokens)).toHaveLength(2);
    store.undo();
    expect(store.doc.tokens["color/two"]).toBeUndefined();
    expect(store.doc.tokens["color/one"]).toBeDefined();
  });

  it("delete_token 删除无引用的 Token", async () => {
    const { store, run } = setup();
    await run("define_token", { path: "color/brand", type: "color", value: "#3366ff" });

    const res = await call(run, "delete_token", { path: "color/brand" });
    expect(res).toMatchObject({ ok: true, path: "color/brand", detached: 0 });
    expect(store.doc.tokens["color/brand"]).toBeUndefined();
  });

  it("delete_token 有引用时默认拒绝，且文档不变", async () => {
    const { store, run } = setup();
    await run("define_token", { path: "color/brand", type: "color", value: "#3366ff" });
    const created = await call(run, "create_node", { kind: "rect", fillToken: "color/brand" });
    const nodeId = created.nodeId as string;

    await expect(run("delete_token", { path: "color/brand" })).rejects.toThrow(/仍被 1 个节点引用/);
    await expect(run("delete_token", { path: "color/brand" })).rejects.toThrow(/detach=true/);
    expect(store.doc.tokens["color/brand"]).toEqual({ type: "color", value: "#3366ff" });
    expect(store.doc.nodes[nodeId].style.fill).toEqual({ token: "color/brand" });
  });

  it("delete_token detach=true 冻结引用为字面量，一条撤销整体还原", async () => {
    const { store, run } = setup();
    await run("define_token", { path: "color/brand", type: "color", value: "#3366ff" });
    const created = await call(run, "create_node", { kind: "rect", fillToken: "color/brand" });
    const nodeId = created.nodeId as string;

    const res = await call(run, "delete_token", { path: "color/brand", detach: true });
    expect(res).toMatchObject({ ok: true, detached: 1 });
    expect(store.doc.tokens["color/brand"]).toBeUndefined();
    expect(store.doc.nodes[nodeId].style.fill).toEqual({ value: "#3366ff" });

    store.undo();
    expect(store.doc.tokens["color/brand"]).toEqual({ type: "color", value: "#3366ff" });
    expect(store.doc.nodes[nodeId].style.fill).toEqual({ token: "color/brand" });
  });

  it("delete_token 拒绝不存在的路径与非法路径", async () => {
    const { run } = setup();
    await expect(run("delete_token", { path: "color/missing" })).rejects.toThrow(/不存在/);
    await expect(run("delete_token", { path: "brand" })).rejects.toThrow(/路径/);
  });
});

describe("AI 工具：选区", () => {
  /** 页面 → 卡片(100,120) → 按钮(10,20)：按钮的世界坐标应是 110,140。 */
  function withSelection() {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const frame = createNode("frame", { name: "卡片", x: 100, y: 120, width: 300, height: 200 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    const rect = createNode("rect", { name: "按钮", x: 10, y: 20, width: 80, height: 40 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: frame.id } });
    const selection = [rect.id, frame.id];
    const run = makeExecutor(store, async () => "", () => pageId, undefined, undefined, () => selection);
    return { store, run, pageId, frame, rect };
  }

  it("返回选区摘要，坐标是世界坐标（嵌套也一样）", async () => {
    const { run, pageId, frame, rect } = withSelection();
    const res = await call(run, "get_selection");
    expect(res.activePageId).toBe(pageId);
    expect(res.nodeIds).toEqual([rect.id, frame.id]);
    const nodes = res.nodes as Record<string, unknown>[];
    expect(nodes[0]).toMatchObject({
      id: rect.id,
      name: "按钮",
      type: "rect",
      parentId: frame.id,
      x: 110,
      y: 140,
      width: 80,
      height: 40,
      locked: false,
      visible: true,
    });
    expect(nodes[1]).toMatchObject({ id: frame.id, x: 100, y: 120, parentId: pageId });
    // 有选中时不该带"空选区"提示
    expect(res.hint).toBeUndefined();
  });

  it("空选区给 hint；宿主不注入读选区能力时也不抛错", async () => {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;

    const empty = makeExecutor(store, async () => "", () => pageId, undefined, undefined, () => []);
    const res = await call(empty, "get_selection");
    expect(res.activePageId).toBe(pageId);
    expect(res.nodeIds).toEqual([]);
    expect(res.nodes).toEqual([]);
    expect(res.hint).toBeTruthy();

    // 老宿主（没传 getSelection）：返回空表而不是 undefined / 抛错
    const fallback = makeExecutor(store, async () => "", () => pageId);
    const res2 = await call(fallback, "get_selection");
    expect(res2.nodeIds).toEqual([]);
  });

  it("选区里已被删除的 id 自动忽略", async () => {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const rect = createNode("rect", { name: "临时", x: 0, y: 0, width: 10, height: 10 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const run = makeExecutor(store, async () => "", () => pageId, undefined, undefined, () => [rect.id]);
    store.apply({ type: "node.delete", params: { nodeId: rect.id } });

    const res = await call(run, "get_selection");
    expect(res.nodeIds).toEqual([]);
    expect(res.hint).toBeTruthy();
  });
});

describe("AI 工具：数值 Token", () => {
  it("create_node 写入字号 / 逐角圆角 / 间距 / 逐边内边距引用", async () => {
    const { store, run } = setup();
    await call(run, "define_token", { path: "size/body", type: "number", value: 18 });
    await call(run, "define_token", { path: "space/md", type: "number", value: 12 });
    await call(run, "define_token", { path: "radius/sm", type: "number", value: 6 });

    const text = await call(run, "create_node", {
      kind: "text",
      text: "标题",
      fontSize: 14,
      fontSizeToken: "size/body",
      cornerRadiusTokens: { topLeft: "radius/sm" },
    });
    const textNode = store.doc.nodes[text.nodeId as string];
    expect(textNode.style.fontSizeToken).toBe("size/body");
    expect(textNode.style.cornerRadiusTokens?.topLeft).toBe("radius/sm");

    const frame = await call(run, "create_node", {
      kind: "frame",
      layout: { gapToken: "space/md", paddingTokens: { left: "space/md" } },
    });
    const frameNode = store.doc.nodes[frame.nodeId as string];
    expect(frameNode.layout?.gapToken).toBe("space/md");
    expect(frameNode.layout?.paddingTokens?.left).toBe("space/md");
    expect(frameNode.layout?.direction).toBe("vertical");
  });

  it("拒绝颜色 Token 与不存在的 Token", async () => {
    const { run } = setup();
    await call(run, "define_token", { path: "color/x", type: "color", value: "#3366ff" });
    await expect(run("create_node", { kind: "text", fontSizeToken: "color/x" })).rejects.toThrow(/数值 Token/);
    await expect(run("create_node", { kind: "text", fontSizeToken: "size/nope" })).rejects.toThrow(/不存在/);
    await expect(
      run("create_node", { kind: "frame", layout: { gapToken: "size/nope" } }),
    ).rejects.toThrow(/不存在/);
  });

  it("update_node 只传 gapToken 时保留其余布局字段", async () => {
    const { store, run } = setup();
    await call(run, "define_token", { path: "space/md", type: "number", value: 12 });
    const frame = await call(run, "create_node", {
      kind: "frame",
      layout: { direction: "horizontal", gap: 4, padding: 8 },
    });
    await call(run, "update_node", { nodeId: frame.nodeId, layout: { gapToken: "space/md" } });
    const node = store.doc.nodes[frame.nodeId as string];
    expect(node.layout?.direction).toBe("horizontal");
    expect(node.layout?.gap).toBe(4);
    expect(node.layout?.padding).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
    expect(node.layout?.gapToken).toBe("space/md");
  });

  it("逐角 / 逐边 Token 按项合并，null 解绑单项", async () => {
    const { store, run } = setup();
    await call(run, "define_token", { path: "radius/sm", type: "number", value: 6 });
    const rect = await call(run, "create_node", { kind: "rect" });
    await call(run, "update_node", {
      nodeId: rect.nodeId,
      cornerRadiusTokens: { topLeft: "radius/sm", topRight: "radius/sm" },
    });
    await call(run, "update_node", { nodeId: rect.nodeId, cornerRadiusTokens: { topLeft: null } });
    const node = store.doc.nodes[rect.nodeId as string];
    expect(node.style.cornerRadiusTokens).toEqual({ topRight: "radius/sm" });
  });

  it("文本测量使用解析后的字号", async () => {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const measured: Array<number | undefined> = [];
    const run = makeExecutor(
      store,
      async () => "",
      () => pageId,
      (_node, style) => {
        measured.push(style.fontSize);
        return { width: 100, height: 20 };
      },
    );
    await call(run, "define_token", { path: "size/body", type: "number", value: 18 });
    await call(run, "create_node", { kind: "text", text: "Hi", fontSize: 10, fontSizeToken: "size/body" });
    expect(measured[0]).toBe(18);
  });

  it("read_document 回传数值引用", async () => {
    const { run } = setup();
    await call(run, "define_token", { path: "size/body", type: "number", value: 18 });
    const created = await call(run, "create_node", { kind: "text", text: "Hi", fontSizeToken: "size/body" });
    const doc = await call(run, "read_document");
    const pages = doc.pages as Array<{ subtree: string }>;
    const flat = JSON.parse(pages[0].subtree) as Array<{ id: string; style?: { fontSizeToken?: string } }>;
    expect(flat.find((n) => n.id === created.nodeId)?.style?.fontSizeToken).toBe("size/body");
  });
});

describe("AI 工具：数值 Token 的字面量解绑", () => {
  it("update_node 只传字面量时自动解绑对应 Token", async () => {
    const { store, run } = setup();
    await call(run, "define_token", { path: "size/body", type: "number", value: 18 });
    await call(run, "define_token", { path: "space/md", type: "number", value: 12 });

    const text = await call(run, "create_node", { kind: "text", text: "Hi", fontSizeToken: "size/body" });
    await call(run, "update_node", { nodeId: text.nodeId, fontSize: 22 });
    const textNode = store.doc.nodes[text.nodeId as string];
    expect(textNode.style.fontSize).toBe(22);
    expect(textNode.style.fontSizeToken).toBeUndefined();

    const frame = await call(run, "create_node", {
      kind: "frame",
      layout: { gapToken: "space/md", paddingTokens: { top: "space/md" } },
    });
    await call(run, "update_node", { nodeId: frame.nodeId, layout: { gap: 6, padding: 3 } });
    const frameNode = store.doc.nodes[frame.nodeId as string];
    expect(frameNode.layout?.gap).toBe(6);
    expect(frameNode.layout?.gapToken).toBeUndefined();
    expect(frameNode.layout?.padding).toEqual({ top: 3, right: 3, bottom: 3, left: 3 });
    expect(frameNode.layout?.paddingTokens).toBeUndefined();
  });
});

describe("AI 工具：inspect_layout 的数值 Token", () => {
  it("存在 Token 时输出解析后的 gap / padding", async () => {
    const { run } = setup();
    await call(run, "define_token", { path: "space/md", type: "number", value: 20 });
    const frame = await call(run, "create_node", {
      kind: "frame",
      layout: { gap: 4, gapToken: "space/md", padding: 2, paddingTokens: { top: "space/md" } },
    });
    const res = await call(run, "inspect_layout", { nodeIds: [frame.nodeId] });
    const rows = res.nodes as Array<{ id: string; resolved?: { gap: number; padding: { top: number } } }>;
    const row = rows.find((item) => item.id === frame.nodeId)!;
    expect(row.resolved?.gap).toBe(20);
    expect(row.resolved?.padding.top).toBe(20);
  });
});
