import { describe, expect, it } from "vitest";
import { createDocWithPage, createEmptyDoc, createNode, DocStore, firstPageId, makeExecutor } from "./helpers";
import { call, setup } from "./helpers";

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


describe("AI 工具：screenshot 文本替代视图", () => {
  function textRun(options: { measureLine?: (text: string) => number } = {}) {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const run = makeExecutor(
      store,
      async () => "data:image/png;base64,AA",
      () => pageId,
      undefined,
      undefined,
      undefined,
      undefined,
      options.measureLine ? { measureLine: options.measureLine } : undefined,
    );
    return { store, pageId, run };
  }

  it("返回区域内的几何与解析后的颜色，不返回图片", async () => {
    const { run, pageId } = textRun();
    await call(run, "define_token", { path: "color/primary", type: "color", value: "#3366ff" });
    const frame = await call(run, "create_node", {
      kind: "frame",
      name: "卡片",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      fill: "#ffffff",
    });
    await call(run, "create_node", {
      kind: "text",
      name: "标题",
      parentId: frame.nodeId,
      x: 10,
      y: 10,
      width: 120,
      height: 20,
      text: "你好",
      fillToken: "color/primary",
    });

    const res = await call(run, "screenshot", {
      format: "text",
      region: { x: 0, y: 0, width: 240, height: 140 },
    });
    expect(res).toMatchObject({ ok: true, format: "text", truncated: false });
    expect(res.image).toBeUndefined();
    expect(res.region).toEqual({ x: 0, y: 0, width: 240, height: 140 });
    const nodes = res.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((n) => n.name)).toEqual(["卡片", "标题"]);
    expect(nodes[0]).toMatchObject({ type: "frame", fill: "#ffffff", text: null, parentId: pageId });
    expect(nodes[1]).toMatchObject({
      type: "text",
      fill: "#3366ff",
      text: "你好",
      parentId: frame.nodeId,
    });
    expect(String(res.hint)).toMatch(/format:"image"/);
  });

  it("默认区域是当前页页面框，页外的节点不进来；悬空 Token 暴露成洋红", async () => {
    const { store, run, pageId } = textRun();
    await call(run, "define_token", { path: "color/primary", type: "color", value: "#3366ff" });
    const outside = await call(run, "create_node", {
      kind: "rect",
      name: "页外",
      x: 2000,
      y: 0,
      width: 40,
      height: 40,
    });
    const dangling = await call(run, "create_node", {
      kind: "rect",
      name: "坏色",
      x: 10,
      y: 10,
      width: 40,
      height: 40,
      fillToken: "color/primary",
    });
    // 模拟「Token 定义丢了」的旧文件：节点上的引用还在
    store.replace({ ...store.doc, tokens: {} });

    const res = await call(run, "screenshot", { format: "text" });
    const nodes = res.nodes as Array<{ id: string; fill: string | null }>;
    expect(nodes.find((n) => n.id === outside.nodeId)).toBeUndefined();
    expect(nodes.find((n) => n.id === dangling.nodeId)?.fill).toBe("#ff00ff");
    expect(nodes.every((n) => n.id !== pageId)).toBe(true);
    expect(res.region).toEqual({ x: 0, y: 0, width: 1440, height: 1024 });
  });

  it("节点超过 200 个时截断", async () => {
    const { run } = textRun();
    for (let i = 0; i < 205; i += 1) {
      await call(run, "create_node", { kind: "rect", x: i * 2, y: 0, width: 1, height: 1 });
    }
    const res = await call(run, "screenshot", { format: "text" });
    expect((res.nodes as unknown[]).length).toBe(200);
    expect(res.truncated).toBe(true);
  });

  it("文本视图也带诊断；没有页面时明确报错", async () => {
    const { run } = textRun({ measureLine: (text) => [...text].length * 10 });
    const bad = await call(run, "create_node", { kind: "rect", name: "零宽", x: 0, y: 0, width: 0, height: 10 });
    const res = await call(run, "screenshot", { format: "text" });
    expect((res.diagnostics as Array<{ code: string; nodeId: string }>)[0]).toMatchObject({
      code: "ZERO_SIZE",
      nodeId: bad.nodeId,
    });

    const empty = new DocStore(createEmptyDoc());
    const bare = makeExecutor(empty, async () => "");
    await expect(bare("screenshot", { format: "text" })).rejects.toThrow(/没有页面/);
  });

  it("format 省略时行为不变（仍返回图片）", async () => {
    const { run } = textRun();
    const res = await call(run, "screenshot", {});
    expect(res).toEqual({ ok: true, image: "data:image/png;base64,AA" });
  });
});


describe("AI 工具：screenshot 参数校验", () => {
  it("format 只接受 image / text", async () => {
    const { run } = setup();
    await expect(run("screenshot", { format: "txt" })).rejects.toThrow(/format/);
    await expect(run("screenshot", { format: "Text" })).rejects.toThrow(/format/);
  });
});
