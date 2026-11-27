import { describe, expect, it } from "vitest";
import { createDocWithPage, createEmptyDoc, createNode, DocStore, firstPageId, makeExecutor } from "./helpers";
import { call, setup } from "./helpers";

/** 1×1 透明 PNG：用于断言 data URL 的尺寸解析。 */
const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("AI 工具：文档级操作与截图区域", () => {
  it("app_state 把工作台状态原样交给 agent", async () => {
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "", undefined, undefined, {
      appState: () => ({
        active: {
          tabId: "t1",
          name: "首页.sqraft",
          path: "/tmp/首页.sqraft",
          dirty: true,
          externalChange: false,
          page: { id: "p1", name: "首页" },
          selection: [{ id: "n1", name: "卡片", type: "frame" }],
        },
        tabs: [
          { tabId: "home", name: "Home", path: null, dirty: false, home: true },
          { tabId: "t1", name: "首页.sqraft", path: "/tmp/首页.sqraft", dirty: true, active: true },
        ],
        limit: 10,
      }),
    });
    const state = await call(run, "app_state");
    expect(state).toMatchObject({
      active: { tabId: "t1", dirty: true, page: { name: "首页" } },
      limit: 10,
    });
    expect(state.tabs).toHaveLength(2);
  });

  it("没有宿主时 app_state 给出可读错误", async () => {
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "");
    await expect(run("app_state", {})).rejects.toThrow(/不支持 app_state/);
  });

  it("app_info 返回宿主版本与当前格式版本", async () => {
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "", undefined, undefined, {
      appInfo: async () => ({ name: "Sqraft", version: "0.1.0", platform: "darwin" }),
    });
    const info = await call(run, "app_info");
    expect(info).toMatchObject({ name: "Sqraft", version: "0.1.0", platform: "darwin" });
    expect(typeof info.formatVersion).toBe("number");
  });

  it("app_info 在没有宿主元信息时明确报错", async () => {
    const store = new DocStore(createDocWithPage());
    const run = makeExecutor(store, async () => "");
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
  it("export_as 校验参数并交给宿主导出", async () => {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const run = makeExecutor(store, async () => "", () => pageId, undefined, {
      exportImage: async (request) =>
        request.format === "svg"
          ? {
              svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"></svg>',
              rasterized: ["背景模糊卡片"],
            }
          : { image: PNG_1X1, rasterized: [] },
    });

    const svg = await call(run, "export_as", { format: "svg" });
    expect(svg.width).toBe(120);
    expect(svg.height).toBe(80);
    expect(svg.svg).toContain("<svg");
    expect(svg.rasterized).toEqual(["背景模糊卡片"]);

    const png = await call(run, "export_as", { format: "png", scale: 4 });
    expect(png.image).toBe(PNG_1X1);
    expect(png.width).toBe(1);

    await expect(run("export_as", { format: "png", scale: 3 })).rejects.toThrow(/scale/);
    await expect(run("export_as", { format: "png", pageId: "missing" })).rejects.toThrow(/pageId/);
  });


  it("import_svg 交给宿主并返回 frame 信息", async () => {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const run = makeExecutor(store, async () => "", () => pageId, undefined, {
      importSvg: async () => ({
        ok: true,
        frameId: "frame-1",
        width: 120,
        height: 80,
        rasterized: ["filter-card"],
        missingFonts: ["Brand Sans"],
        warnings: [{ code: "IGNORED_TAG", element: "script", message: "<script> was dropped" }],
      }),
    });

    const result = await call(run, "import_svg", { svg: "<svg/>" });
    expect(result.frameId).toBe("frame-1");
    expect(result.width).toBe(120);
    expect(result.rasterized).toEqual(["filter-card"]);
    expect(result.missingFonts).toEqual(["Brand Sans"]);
    expect(result.warnings).toEqual([{ code: "IGNORED_TAG", element: "script", message: "<script> was dropped" }]);

    await expect(run("import_svg", { svg: "   " })).rejects.toThrow(/svg/);
  });

  it("import_svg 把整份失败的原因翻成可执行文案，上限数字来自宿主", async () => {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const cases = [
      { failure: { ok: false, reason: "invalid-svg" } as const, expected: /不是合法/ },
      { failure: { ok: false, reason: "no-size" } as const, expected: /缺少有效尺寸/ },
      { failure: { ok: false, reason: "empty-content" } as const, expected: /没有可导入/ },
      { failure: { ok: false, reason: "node-limit", limit: 1234 } as const, expected: /1234 个节点/ },
      { failure: { ok: false, reason: "raster-limit", limit: 42 } as const, expected: /42 个栅格化/ },
    ];
    for (const { failure, expected } of cases) {
      const run = makeExecutor(store, async () => "", () => pageId, undefined, {
        importSvg: async () => failure,
      });
      await expect(run("import_svg", { svg: "<svg/>" })).rejects.toThrow(expected);
    }
  });

  it("import_svg 失败时带上被忽略元素的摘要", async () => {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const run = makeExecutor(store, async () => "", () => pageId, undefined, {
      importSvg: async () => ({
        ok: false,
        reason: "empty-content",
        warnings: [
          { code: "IGNORED_TAG", element: "script", message: "<script> was dropped" },
          { code: "IGNORED_TAG", element: "script", message: "<script> was dropped" },
          { code: "IGNORED_TAG", element: "foreignobject", message: "<foreignobject> was dropped" },
          { code: "UNSUPPORTED_ELEMENT", element: "foo", message: "<foo> was skipped" },
        ],
      }),
    });
    await expect(run("import_svg", { svg: "<svg/>" })).rejects.toThrow(/已忽略 4 个元素：script、foreignobject、foo/);
  });

  it("import_svg 成功但没有降级时省略 warnings", async () => {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const run = makeExecutor(store, async () => "", () => pageId, undefined, {
      importSvg: async () => ({
        ok: true,
        frameId: "frame-1",
        width: 10,
        height: 10,
        rasterized: [],
        missingFonts: [],
        warnings: [],
      }),
    });
    const result = await call(run, "import_svg", { svg: "<svg/>" });
    expect(result.warnings).toBeUndefined();
    expect(result.rasterized).toBeUndefined();
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

  it("文本视图把渐变报成类型 + 解析后的色标", async () => {
    const { run } = textRun();
    await call(run, "define_token", { path: "color/a", type: "color", value: "#22c55e" });
    const rect = await call(run, "create_node", {
      kind: "rect",
      name: "渐变",
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      fillGradient: {
        type: "linear",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 0 },
        stops: [
          { offset: 0, color: { token: "color/a" } },
          { offset: 1, color: { value: "#06b6d4" } },
        ],
      },
    });
    const res = await call(run, "screenshot", {
      format: "text",
      region: { x: 0, y: 0, width: 120, height: 80 },
    });
    const row = (res.nodes as Array<Record<string, unknown>>).find((n) => n.id === rect.nodeId)!;
    expect(row.fill).toBeNull();
    expect(row.fillGradient).toEqual({
      type: "linear",
      stops: [
        { offset: 0, color: "#22c55e" },
        { offset: 1, color: "#06b6d4" },
      ],
    });
  });

  it("文本视图把渐变 Token 引用展开成渐变并带上 Token 路径", async () => {
    const { run } = textRun();
    await call(run, "define_token", { path: "color/a", type: "color", value: "#6366f1" });
    await call(run, "define_token", { path: "color/b", type: "color", value: "#a855f7" });
    await call(run, "define_token", {
      path: "gradient/brand",
      type: "gradient",
      value: {
        type: "linear",
        from: { x: 0, y: 0.5 },
        to: { x: 1, y: 0.5 },
        stops: [
          { offset: 0, color: { token: "color/a" } },
          { offset: 1, color: { token: "color/b" } },
        ],
      },
    });
    const rect = await call(run, "create_node", {
      kind: "rect",
      name: "引用渐变",
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      fillToken: "gradient/brand",
    });
    const res = await call(run, "screenshot", {
      format: "text",
      region: { x: 0, y: 0, width: 120, height: 80 },
    });
    const row = (res.nodes as Array<Record<string, unknown>>).find((n) => n.id === rect.nodeId)!;
    expect(row.fill).toBeNull();
    expect(row.fillToken).toBe("gradient/brand");
    expect(row.fillGradient).toEqual({
      type: "linear",
      stops: [
        { offset: 0, color: "#6366f1" },
        { offset: 1, color: "#a855f7" },
      ],
    });
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
