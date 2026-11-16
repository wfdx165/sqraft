import { describe, expect, it } from "vitest";
import { MUTATING_TOOLS } from "../src/handlers";
import { toMCPManifest } from "../src/index";
import { call, createEmptyDoc, DocStore, makeExecutor, setup } from "./helpers";

/** 5 张卡片 × (画板 + 缩略图 + 标题) = 15 个节点，一屏的典型结构。 */
function cardList(count = 5) {
  return Array.from({ length: count }, (_, i) => ({
    id: `card${i}`,
    kind: "frame",
    name: `卡片 ${i}`,
    x: i * 200,
    y: 0,
    width: 180,
    height: 120,
    children: [
      { id: `thumb${i}`, kind: "rect", name: "缩略图", x: 0, y: 0, width: 180, height: 80 },
      { id: `label${i}`, kind: "text", name: "标题", text: `标题 ${i}`, x: 0, y: 88 },
    ],
  }));
}

describe("create_nodes：批量建树", () => {
  it("一次调用建出整棵子树，父子关系就位", async () => {
    const { store, run, pageId } = setup();
    const res = await call(run, "create_nodes", { nodes: cardList() });

    expect(res.count).toBe(15);
    expect(res.created).toHaveLength(15);
    // 页面 + 15 个新节点
    expect(Object.keys(store.doc.nodes)).toHaveLength(16);

    // 深度优先顺序：先父后子
    expect((res.created as string[]).slice(0, 3)).toEqual(["card0", "thumb0", "label0"]);
    // 子节点的 parentId 与父节点的 children 数组必须对上（node.create 只挂 nodes[0]）
    expect(store.doc.nodes.thumb0.parentId).toBe("card0");
    expect(store.doc.nodes.label0.parentId).toBe("card0");
    expect(store.doc.nodes.card0.children).toEqual(["thumb0", "label0"]);
    // 整棵树挂在当前页面下
    expect(store.doc.nodes[pageId].children).toEqual(["card0", "card1", "card2", "card3", "card4"]);
  });

  it("一次撤销撤掉整棵树（一次 MCP 调用 = 一个撤销步）", async () => {
    const { store, run, pageId } = setup();
    await call(run, "create_nodes", { nodes: cardList() });
    expect(Object.keys(store.doc.nodes)).toHaveLength(16);

    store.undo();
    expect(Object.keys(store.doc.nodes)).toHaveLength(1);
    expect(store.doc.nodes[pageId]).toBeDefined();
  });

  it("任一节点非法则整次回滚，不留下半截", async () => {
    const { store, run } = setup();
    const before = Object.keys(store.doc.nodes).length;

    // 第三个子节点缺 points：前两个是合法的，仍必须一个都不落
    await expect(
      run("create_nodes", {
        nodes: [
          {
            id: "ok",
            kind: "frame",
            children: [
              { id: "a", kind: "rect" },
              { id: "b", kind: "text", text: "hi" },
              { id: "bad", kind: "path" },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/nodes\[0\]\.children\[2\]/);

    expect(Object.keys(store.doc.nodes)).toHaveLength(before);
    expect(store.doc.nodes.ok).toBeUndefined();
    expect(store.doc.nodes.a).toBeUndefined();
    expect(store.undoLabel).toBeNull();
  });

  it("kind 不支持时拒绝，不写入垃圾节点", async () => {
    const { store, run } = setup();
    const before = Object.keys(store.doc.nodes).length;
    await expect(
      run("create_nodes", { nodes: [{ id: "x", kind: "banana" }] }),
    ).rejects.toThrow(/INVALID_NODE：nodes\[0\]/);
    expect(Object.keys(store.doc.nodes)).toHaveLength(before);
  });

  it("超 500 个节点报 TOO_MANY_NODES", async () => {
    const { store, run } = setup();
    const before = Object.keys(store.doc.nodes).length;
    const nodes = Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, kind: "rect" }));
    await expect(run("create_nodes", { nodes })).rejects.toThrow(/TOO_MANY_NODES/);
    expect(Object.keys(store.doc.nodes)).toHaveLength(before);
  });

  it("缺 id / id 重复时拒绝，错误里带条目路径", async () => {
    const { run } = setup();
    await expect(run("create_nodes", { nodes: [{ kind: "rect" }] })).rejects.toThrow(
      /ID_REQUIRED：nodes\[0\]/,
    );
    await expect(
      run("create_nodes", {
        nodes: [
          { id: "dup", kind: "rect" },
          { id: "dup", kind: "rect" },
        ],
      }),
    ).rejects.toThrow(/DUPLICATE_ID：nodes\[1\]/);
    // 与文档里已有的 id 撞车
    await call(run, "create_nodes", { nodes: [{ id: "once", kind: "rect" }] });
    await expect(run("create_nodes", { nodes: [{ id: "once", kind: "rect" }] })).rejects.toThrow(
      /DUPLICATE_ID/,
    );
  });

  it("children 里不许放主组件与插槽", async () => {
    const { run } = setup();
    await expect(
      run("create_nodes", { nodes: [{ id: "a", kind: "frame", children: [{ id: "b", kind: "component" }] }] }),
    ).rejects.toThrow(/NESTED_SPECIAL_KIND：nodes\[0\]\.children\[0\]/);
    await expect(
      run("create_nodes", {
        nodes: [{ id: "a", kind: "frame", children: [{ id: "b", kind: "slot", name: "s" }] }],
      }),
    ).rejects.toThrow(/NESTED_SPECIAL_KIND/);
  });

  it("顶层可以单独建一个主组件，但不能与其它顶层节点同批", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_nodes", {
      nodes: [{ id: "comp", kind: "component", name: "按钮", children: [{ id: "lbl", kind: "text", text: "确定" }] }],
    });
    expect(res.created).toEqual(["comp", "lbl"]);
    expect(store.doc.rootIds).toContain("comp");
    expect(store.doc.nodes.comp.parentId).toBeNull();

    await expect(
      run("create_nodes", {
        nodes: [{ id: "c2", kind: "component" }, { id: "r", kind: "rect" }],
      }),
    ).rejects.toThrow(/主组件必须单独一次调用/);
    await expect(
      run("create_nodes", { parentId: store.doc.rootIds[0] as string, nodes: [{ id: "c3", kind: "component" }] }),
    ).rejects.toThrow(/不接受 parentId/);
  });

  it("自动布局容器里的子节点由布局求解写回位置", async () => {
    const { store, run } = setup();
    await call(run, "create_nodes", {
      nodes: [
        {
          id: "row",
          kind: "frame",
          x: 0,
          y: 0,
          width: 600,
          height: 80,
          layout: { direction: "horizontal", gap: 16, padding: 8 },
          children: [
            { id: "a", kind: "rect", width: 100, height: 40 },
            { id: "b", kind: "rect", width: 100, height: 40 },
          ],
        },
      ],
    });
    // 两个子节点不能都叠在 0,0：布局求解按 gap/padding 摆开
    expect(store.doc.nodes.a.x).not.toBe(store.doc.nodes.b.x);
    expect(store.doc.nodes.a.x).toBe(8);
    expect(store.doc.nodes.b.x).toBe(8 + 100 + 16);
  });

  it("create_node 回归：单建行为与返回体不变", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_node", { kind: "rect", name: "单个" });
    expect(res).toEqual({ ok: true, nodeId: res.nodeId });
    expect(store.doc.nodes[res.nodeId as string].name).toBe("单个");
  });

  it("空文档自动补页时仍是撤销一步：create_nodes 必须在 MUTATING_TOOLS 里", async () => {
    // 漏进 MUTATING_TOOLS 就不会被 transact 包住：补页与建树会分成两条撤销记录，
    // 诊断也不会附在响应上、画布上不出现活动胶囊——所以这条必须钉住。
    expect(MUTATING_TOOLS.has("create_nodes")).toBe(true);

    const store = new DocStore(createEmptyDoc());
    const run = makeExecutor(store, async () => "");
    await call(run, "create_nodes", { nodes: [{ id: "r", kind: "rect" }] });
    // 页面 + 矩形
    expect(Object.keys(store.doc.nodes)).toHaveLength(2);

    store.undo();
    expect(Object.keys(store.doc.nodes)).toHaveLength(0);
  });

  it("create_nodes 的 inputSchema 没有悬空 $ref", () => {
    // 递归结构用 $defs + #/$defs/Node；写 "#/Node" 会让按 schema 校验的客户端解析失败
    const schema = toMCPManifest().find((tool) => tool.name === "create_nodes")?.inputSchema;
    expect(schema).toBeDefined();
    const refs = [...JSON.stringify(schema).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const path = ref.replace(/^#\//, "").split("/");
      let cursor: unknown = schema;
      for (const key of path) cursor = (cursor as Record<string, unknown> | undefined)?.[key];
      expect(cursor, `悬空引用 ${ref}`).toBeDefined();
    }
  });
});
