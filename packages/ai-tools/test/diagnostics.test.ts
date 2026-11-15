import { describe, expect, it } from "vitest";
import { createDocWithPage, DocStore, firstPageId, makeExecutor } from "./helpers";
import { call, setup } from "./helpers";

describe("AI 工具：inspect_layout 复用诊断", () => {
  it("几何行不变，问题随同一响应返回；改好后字段消失", async () => {
    const { run } = setup();
    const created = await call(run, "create_node", { kind: "rect", name: "零宽", width: 0, height: 10 });

    const before = await call(run, "inspect_layout");
    expect(before.nodes).toHaveLength(1);
    const codes = (before.diagnostics as Array<{ code: string; nodeId: string }>).map((d) => d.code);
    expect(codes).toEqual(["ZERO_SIZE"]);
    expect((before.diagnostics as Array<{ nodeId: string }>)[0].nodeId).toBe(created.nodeId);

    await call(run, "update_node", { nodeId: created.nodeId, width: 40 });
    const after = await call(run, "inspect_layout");
    expect(after.diagnostics).toBeUndefined();
    expect(after.diagnosticsTruncated).toBeUndefined();
  });

  it("注入逐行度量后报文本溢出", async () => {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const measureLine = (text: string) => [...text].length * 10;
    const run = makeExecutor(
      store,
      async () => "",
      () => pageId,
      undefined,
      undefined,
      undefined,
      undefined,
      { measureLine },
    );
    await call(run, "create_node", {
      kind: "text",
      name: "定高文本",
      text: "字".repeat(20),
      width: 100,
      height: 10,
      textAutoResize: "fixed",
      fill: "#111111",
    });
    const res = await call(run, "inspect_layout");
    expect((res.diagnostics as Array<{ code: string }>).map((d) => d.code)).toEqual(["TEXT_OVERFLOW"]);
  });
});


describe("AI 工具：写工具附带诊断", () => {
  it("正常写入不带 diagnostics 字段", async () => {
    const { run } = setup();
    const res = await call(run, "create_node", { kind: "rect", width: 40, height: 40 });
    expect(res).toEqual({ ok: true, nodeId: expect.any(String) });
  });

  it("零尺寸与无填充文本随同一响应返回", async () => {
    const { run } = setup();
    const zero = await call(run, "create_node", { kind: "rect", name: "零宽", width: 0, height: 10 });
    expect((zero.diagnostics as Array<{ code: string; nodeId: string }>)[0]).toMatchObject({
      code: "ZERO_SIZE",
      nodeId: zero.nodeId,
    });

    const text = await call(run, "create_node", { kind: "text", name: "标题", text: "标题" });
    const codes = (text.diagnostics as Array<{ code: string }>).map((d) => d.code);
    expect(codes).toContain("TEXT_NO_FILL");
  });

  it("改好之后不再报，ok 与撤销粒度不变", async () => {
    const { store, run } = setup();
    const zero = await call(run, "create_node", { kind: "rect", width: 0, height: 10 });
    const fixed = await call(run, "update_node", { nodeId: zero.nodeId, width: 80 });
    expect(fixed).toEqual({ ok: true });

    store.undo();
    store.undo();
    expect(store.canUndo).toBe(false);
  });

  it("move_node 移到父容器外时报 OUTSIDE_PARENT", async () => {
    const { run } = setup();
    const frame = await call(run, "create_node", { kind: "frame", x: 0, y: 0, width: 200, height: 200 });
    const rect = await call(run, "create_node", { kind: "rect", x: 900, y: 0, width: 40, height: 40 });
    const moved = await call(run, "move_node", {
      nodeId: rect.nodeId,
      parentId: frame.nodeId,
      absolute: true,
    });
    expect((moved.diagnostics as Array<{ code: string }>).map((d) => d.code)).toContain("OUTSIDE_PARENT");
  });

  it("Token 级改动扫全文档，暴露已存在的悬空引用", async () => {
    const { store, run } = setup();
    await call(run, "define_token", { path: "color/primary", type: "color", value: "#3366ff" });
    await call(run, "create_node", { kind: "rect", fillToken: "color/primary" });
    // 模拟「读进来的旧文件里 Token 定义丢了」：文档里留着引用
    store.replace({ ...store.doc, tokens: {} });

    const defined = await call(run, "define_token", { path: "color/secondary", type: "color", value: "#111111" });
    expect((defined.diagnostics as Array<{ code: string; message: string }>)[0]).toMatchObject({
      code: "TOKEN_MISSING",
      message: 'Token "color/primary" is not defined.',
    });
  });

  it("一次改很多节点时按 20 条截断", async () => {
    const { run } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const created = await call(run, "create_node", { kind: "rect", x: i * 10, width: 0, height: 10 });
      ids.push(created.nodeId as string);
    }
    const arranged = await call(run, "arrange_nodes", { nodeIds: ids, action: "align-left" });
    expect((arranged.diagnostics as unknown[]).length).toBe(20);
    expect(arranged.diagnosticsTruncated).toBe(true);
  });

  it("诊断不阻断写入，也不新建撤销步", async () => {
    const { store, run } = setup();
    const before = store.undoLabel;
    const res = await call(run, "create_node", { kind: "text", text: "无颜色" });
    expect(res.ok).toBe(true);
    expect(store.undoLabel).not.toBe(before);
    store.undo();
    expect(store.doc.nodes[res.nodeId as string]).toBeUndefined();
  });
});


describe("AI 工具：诊断范围（回归）", () => {
  it("别处已有的问题不会因为新建无关节点被重复报出来", async () => {
    const { run } = setup();
    const zero = await call(run, "create_node", { kind: "rect", name: "零宽", width: 0, height: 10 });
    expect((zero.diagnostics as Array<{ code: string }>)[0].code).toBe("ZERO_SIZE");

    // 页面因为 children 变了也会进 changed：不能拿它当扫描根，否则整页历史问题都会重报
    const normal = await call(run, "create_node", { kind: "rect", x: 400, y: 400, width: 40, height: 40 });
    expect(normal.diagnostics).toBeUndefined();
  });

  it("一次事务只报本次动到的节点", async () => {
    const { run } = setup();
    await call(run, "create_node", { kind: "rect", name: "零宽", width: 0, height: 10 });
    // 用矩形当容器：画板默认带自动布局，会把子项搬回内容区
    const box = await call(run, "create_node", {
      kind: "rect",
      x: 200,
      y: 200,
      width: 100,
      height: 100,
      fill: "#ffffff",
    });
    const res = await call(run, "create_node", {
      kind: "rect",
      parentId: box.nodeId,
      name: "子项",
      x: 900,
      y: 900,
      width: 20,
      height: 20,
    });
    // 只有新子项在父容器外；容器与更早的零宽节点都不该出现在本次诊断里
    expect(res.diagnostics as Array<{ code: string; nodeId: string }>).toEqual([
      expect.objectContaining({ code: "OUTSIDE_PARENT", nodeId: res.nodeId }),
    ]);
  });
});


describe("AI 工具：诊断范围（写工具只查 changed）", () => {
  it("从页面删除节点不重报同页历史问题", async () => {
    const { run } = setup();
    await call(run, "create_node", { kind: "rect", name: "历史坏节点", width: 0, height: 10 });
    const good = await call(run, "create_node", { kind: "rect", x: 100, y: 100, width: 40, height: 40 });
    const removed = await call(run, "delete_node", { nodeId: good.nodeId });
    expect(removed).toEqual({ ok: true });
  });

  it("删除整棵子树也不重报（已删节点不再参与诊断）", async () => {
    const { run } = setup();
    await call(run, "create_node", { kind: "rect", name: "历史坏节点", width: 0, height: 10 });
    const frame = await call(run, "create_node", { kind: "frame", x: 400, y: 0, width: 200, height: 200 });
    const nested = await call(run, "create_node", {
      kind: "rect",
      parentId: frame.nodeId,
      name: "子树里的坏节点",
      width: 0,
      height: 10,
    });
    expect((nested.diagnostics as Array<{ code: string }>)[0].code).toBe("ZERO_SIZE");

    const removed = await call(run, "delete_node", { nodeId: frame.nodeId });
    expect(removed).toEqual({ ok: true });
  });

  it("复制子树时每个新节点都被检查", async () => {
    const { run } = setup();
    const frame = await call(run, "create_node", { kind: "frame", x: 200, y: 200, width: 200, height: 200 });
    const zero = await call(run, "create_node", {
      kind: "rect",
      parentId: frame.nodeId,
      name: "零宽",
      width: 0,
      height: 10,
    });
    const duplicated = await call(run, "duplicate_node", { nodeId: frame.nodeId });
    const diagnostics = duplicated.diagnostics as Array<{ code: string; nodeId: string }>;
    expect(diagnostics.filter((d) => d.code === "ZERO_SIZE")).toHaveLength(1);
    expect(diagnostics[0].nodeId).not.toBe(zero.nodeId);
    expect((duplicated.nodeIds as string[]).length).toBe(1);
  });

  it("把节点移出页面不触发整页重扫", async () => {
    const { run, pageId } = setup();
    await call(run, "create_node", { kind: "rect", name: "历史坏节点", width: 0, height: 10 });
    const frame = await call(run, "create_node", { kind: "frame", x: 400, y: 0, width: 200, height: 200 });
    const node = await call(run, "create_node", {
      kind: "rect",
      parentId: frame.nodeId,
      x: 10,
      y: 10,
      width: 40,
      height: 40,
    });
    const moved = await call(run, "move_node", { nodeId: node.nodeId, parentId: pageId, absolute: true });
    expect(moved).toEqual({ ok: true, nodeId: node.nodeId, parentId: pageId, inFlow: false });
    expect(moved.diagnostics).toBeUndefined();
  });
});
