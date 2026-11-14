import { describe, expect, it } from "vitest";
import { createEmptyDoc, DocStore, makeExecutor } from "./helpers";
import { call, setup } from "./helpers";

describe("AI 工具：read_document 作用域", () => {
  it("默认读当前页一层，depth 逐层展开", async () => {
    const { run, pageId } = setup();
    const a = await call(run, "create_node", { kind: "frame", name: "A" });
    const b = await call(run, "create_node", { kind: "frame", name: "B", parentId: a.nodeId });
    const c = await call(run, "create_node", { kind: "rect", name: "C", parentId: b.nodeId });

    const one = await call(run, "read_document");
    expect(one).toMatchObject({ scope: "page", pageId, rootId: pageId, depth: 1, truncated: false, hasMore: false });
    expect((one.nodes as Array<{ id: string; depth: number }>).map((n) => n.id)).toEqual([pageId, a.nodeId]);
    expect((one.nodes as Array<{ depth: number }>).map((n) => n.depth)).toEqual([0, 1]);

    const two = await call(run, "read_document", { depth: 2 });
    expect((two.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual([pageId, a.nodeId, b.nodeId]);

    const three = await call(run, "read_document", { depth: 3 });
    expect((three.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual([pageId, a.nodeId, b.nodeId, c.nodeId]);
  });

  it("depth=0 只给作用域根", async () => {
    const { run, pageId } = setup();
    await call(run, "create_node", { kind: "rect" });
    const doc = await call(run, "read_document", { depth: 0 });
    expect((doc.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual([pageId]);
  });

  it("scope=subtree 以该节点为根，depth 相对它算", async () => {
    const { run, pageId } = setup();
    const a = await call(run, "create_node", { kind: "frame", name: "A" });
    const b = await call(run, "create_node", { kind: "rect", name: "B", parentId: a.nodeId });

    const doc = await call(run, "read_document", { scope: "subtree", subtreeId: a.nodeId });
    expect(doc).toMatchObject({ scope: "subtree", pageId, rootId: a.nodeId, depth: 1 });
    expect((doc.nodes as Array<{ id: string; depth: number }>)).toMatchObject([
      { id: a.nodeId, depth: 0 },
      { id: b.nodeId, depth: 1 },
    ]);
  });

  it("页面不存在 / 不是页面 / 缺 subtreeId 都报错", async () => {
    const { run } = setup();
    const rect = await call(run, "create_node", { kind: "rect" });
    await expect(run("read_document", { pageId: "nope" })).rejects.toThrow(/不存在/);
    await expect(run("read_document", { pageId: rect.nodeId })).rejects.toThrow(/不是页面/);
    await expect(run("read_document", { scope: "subtree" })).rejects.toThrow(/subtreeId/);
    await expect(run("read_document", { scope: "subtree", subtreeId: "nope" })).rejects.toThrow(/不存在/);
    await expect(run("read_document", { scope: "nope" })).rejects.toThrow(/scope/);
  });

  it("limit 夹紧并在截断时给 hint", async () => {
    const { run } = setup();
    for (let i = 0; i < 3; i += 1) await call(run, "create_node", { kind: "rect", name: `R${i}` });

    const cut = await call(run, "read_document", { limit: 2 });
    expect(cut.nodes).toHaveLength(2);
    expect(cut).toMatchObject({ truncated: true, hasMore: true });
    expect(String(cut.hint)).toMatch(/Truncated at 2 nodes/);

    // 0 夹到 1；超过上限不报错
    const clamped = await call(run, "read_document", { limit: 0 });
    expect(clamped.nodes).toHaveLength(1);
    expect(clamped.truncated).toBe(true);

    const fit = await call(run, "read_document", { limit: 4 });
    expect(fit).toMatchObject({ truncated: false, hasMore: false });
    expect(fit.hint).toBeUndefined();
  });

  it("空文档返回空数组，不自动建页", async () => {
    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "");
    const doc = await call(run, "read_document");
    expect(doc).toMatchObject({ scope: "page", pageId: null, rootId: null, nodes: [], tokenCount: 0 });
    expect(String(doc.hint)).toMatch(/no pages/);
    expect(store.doc.rootIds).toHaveLength(0);
  });

  it("scope=document 只给页面与组件摘要", async () => {
    const { run, pageId } = setup();
    const frame = await call(run, "create_node", { kind: "frame" });
    await call(run, "create_node", { kind: "rect", parentId: frame.nodeId });
    const comp = await call(run, "create_node", { kind: "component", width: 120, height: 40 });
    await call(run, "create_node", { kind: "rect", parentId: comp.nodeId, width: 20, height: 20 });
    await call(run, "define_token", { path: "color/primary", type: "color", value: "#3366ff" });

    const doc = await call(run, "read_document", { scope: "document" });
    expect(doc).toMatchObject({ scope: "document", tokenCount: 1, truncated: false, hasMore: false });
    expect((doc.pages as Array<Record<string, unknown>>).find((p) => p.pageId === pageId)).toMatchObject({
      nodeCount: 3,
      width: 1440,
      height: 1024,
    });
    expect((doc.components as Array<Record<string, unknown>>).find((c) => c.componentId === comp.nodeId)).toMatchObject({
      nodeCount: 2,
      width: 120,
      height: 40,
    });
    expect(doc.nodes).toBeUndefined();
  });

  it("组件子树读出来 pageId 为 null，tokenCount 照给", async () => {
    const { run } = setup();
    await call(run, "define_token", { path: "color/primary", type: "color", value: "#3366ff" });
    const comp = await call(run, "create_node", { kind: "component" });
    const doc = await call(run, "read_document", { scope: "subtree", subtreeId: comp.nodeId });
    expect(doc).toMatchObject({ pageId: null, rootId: comp.nodeId, tokenCount: 1 });
  });
});


describe("AI 工具：search_nodes", () => {
  it("按名称子串命中，带名称链与顶层归属", async () => {
    const { run, pageId } = setup();
    const frame = await call(run, "create_node", { kind: "frame", name: "卡片" });
    const rect = await call(run, "create_node", { kind: "rect", name: "主按钮", parentId: frame.nodeId });
    await call(run, "create_node", { kind: "rect", name: "次按钮" });

    const res = await call(run, "search_nodes", { name: "按钮" });
    const hits = res.hits as Array<Record<string, unknown>>;
    expect(hits.map((h) => h.id)).toEqual([rect.nodeId, expect.any(String)]);
    expect(hits[0]).toMatchObject({
      id: rect.nodeId,
      name: "主按钮",
      type: "rect",
      parentId: frame.nodeId,
      rootKind: "page",
      rootId: pageId,
      path: ["页面 1", "卡片"],
      match: { field: "name", snippet: "主按钮" },
    });
    expect(res.hasMore).toBe(false);
  });

  it("大小写不敏感；命中行没有子树也没有坐标", async () => {
    const { run } = setup();
    await call(run, "create_node", { kind: "frame", name: "Hero Card" });
    const res = await call(run, "search_nodes", { name: "hero" });
    const hit = (res.hits as Array<Record<string, unknown>>)[0];
    expect(hit.name).toBe("Hero Card");
    expect(hit.subtree).toBeUndefined();
    expect(hit.children).toBeUndefined();
    expect(hit.x).toBeUndefined();
    expect(hit.style).toBeUndefined();
  });

  it("text / type / fillToken 过滤，多个条件是 AND", async () => {
    const { run } = setup();
    await call(run, "define_token", { path: "color/primary", type: "color", value: "#3366ff" });
    const a = await call(run, "create_node", { kind: "text", text: "立即购买", fillToken: "color/primary" });
    await call(run, "create_node", { kind: "text", text: "了解更多", fillToken: "color/primary" });
    const c = await call(run, "create_node", { kind: "rect", fillToken: "color/primary" });

    const byText = await call(run, "search_nodes", { text: "购买" });
    expect((byText.hits as Array<{ id: string }>).map((h) => h.id)).toEqual([a.nodeId]);

    const byType = await call(run, "search_nodes", { type: ["rect", "ellipse"] });
    expect((byType.hits as Array<{ id: string }>).map((h) => h.id)).toEqual([c.nodeId]);

    const byToken = await call(run, "search_nodes", { fillToken: "color/primary" });
    expect((byToken.hits as Array<{ id: string }>).length).toBe(3);

    // AND：文本 + 类型（文本节点不是 rect）
    const none = await call(run, "search_nodes", { text: "购买", type: "rect" });
    expect(none.hits).toEqual([]);
    expect(String(none.hint)).toMatch(/No matches/);
  });

  it("componentId 同时命中母版与实例", async () => {
    const { run } = setup();
    const comp = await call(run, "create_node", { kind: "component", name: "按钮" });
    const inst = await call(run, "create_instance", { componentId: comp.nodeId });

    const res = await call(run, "search_nodes", { componentId: comp.nodeId as string });
    const hits = res.hits as Array<Record<string, unknown>>;
    expect(hits.find((h) => h.id === comp.nodeId)).toMatchObject({ rootKind: "component", rootId: comp.nodeId });
    expect(hits.find((h) => h.id === inst.nodeId)).toMatchObject({
      rootKind: "page",
      componentId: comp.nodeId,
    });
  });

  it("pageId 限定单页，组件母版被排除在外", async () => {
    const { run, pageId } = setup();
    const b = await call(run, "create_page", { name: "B" });
    await call(run, "create_node", { kind: "rect", name: "同名", parentId: pageId });
    const onB = await call(run, "create_node", { kind: "rect", name: "同名", parentId: b.pageId });
    await call(run, "create_node", { kind: "component", name: "同名" });

    const inB = await call(run, "search_nodes", { name: "同名", pageId: b.pageId });
    expect((inB.hits as Array<{ id: string }>).map((h) => h.id)).toEqual([onB.nodeId]);

    const all = await call(run, "search_nodes", { name: "同名" });
    expect((all.hits as Array<{ rootKind: string }>).map((h) => h.rootKind)).toEqual(["page", "page", "component"]);
  });

  it("隐藏节点连同子树默认跳过，includeHidden 才给", async () => {
    const { run } = setup();
    const frame = await call(run, "create_node", { kind: "frame", name: "隐藏区" });
    await call(run, "create_node", { kind: "rect", name: "隐藏子项", parentId: frame.nodeId });
    await call(run, "update_node", { nodeId: frame.nodeId, visible: false });

    expect((await call(run, "search_nodes", { name: "隐藏" })).hits).toEqual([]);
    const shown = await call(run, "search_nodes", { name: "隐藏", includeHidden: true });
    expect((shown.hits as Array<{ id: string }>).length).toBe(2);
  });

  it("limit 与 hasMore，越界夹紧", async () => {
    const { run } = setup();
    for (let i = 0; i < 3; i += 1) await call(run, "create_node", { kind: "rect", name: `R${i}` });

    const cut = await call(run, "search_nodes", { name: "R", limit: 1 });
    expect((cut.hits as unknown[]).length).toBe(1);
    expect(cut.hasMore).toBe(true);
    expect(String(cut.hint)).toMatch(/More matches/);

    const all = await call(run, "search_nodes", { name: "R", limit: 999 });
    expect((all.hits as unknown[]).length).toBe(3);
    expect(all.hasMore).toBe(false);
  });

  it("超长名称的 snippet 截到 80 字符", async () => {
    const { run } = setup();
    const long = "字".repeat(100);
    await call(run, "create_node", { kind: "rect", name: long });
    const res = await call(run, "search_nodes", { name: "字" });
    const snippet = String((res.hits as Array<{ match: { snippet: string } }>)[0].match.snippet);
    expect([...snippet]).toHaveLength(80);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("参数校验", async () => {
    const { run } = setup();
    const rect = await call(run, "create_node", { kind: "rect" });
    await expect(run("search_nodes", {})).rejects.toThrow(/至少需要一个过滤条件/);
    await expect(run("search_nodes", { type: "nope" })).rejects.toThrow(/未知节点类型/);
    await expect(run("search_nodes", { type: [] })).rejects.toThrow(/空数组/);
    await expect(run("search_nodes", { name: "x", pageId: "nope" })).rejects.toThrow(/不存在/);
    await expect(run("search_nodes", { name: "x", pageId: rect.nodeId })).rejects.toThrow(/不是页面/);
  });
});


describe("AI 工具：读取/搜索的边界", () => {
  it("截断与弃用提示同时命中时两句话都在", async () => {
    const { run } = setup();
    await call(run, "create_node", { kind: "component" });
    await call(run, "create_node", { kind: "rect" });
    await call(run, "create_node", { kind: "rect" });
    const res = await call(run, "read_document", { limit: 1, includeComponentTrees: true });
    expect(String(res.hint)).toContain("Truncated at 1 nodes");
    expect(String(res.hint)).toContain("deprecated");
  });

  it("strokeToken 过滤只命中描边引用", async () => {
    const { run } = setup();
    await call(run, "define_token", { path: "color/line", type: "color", value: "#111111" });
    const stroked = await call(run, "create_node", { kind: "rect", strokeToken: "color/line" });
    await call(run, "create_node", { kind: "rect", fillToken: "color/line", strokeToken: undefined });
    const res = await call(run, "search_nodes", { strokeToken: "color/line" });
    const hits = res.hits as Array<{ id: string; match: { field: string } }>;
    expect(hits.map((h) => h.id)).toEqual([stroked.nodeId]);
    expect(hits[0].match.field).toBe("strokeToken");
  });
});
