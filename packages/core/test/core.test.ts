import { describe, expect, it } from "vitest";
import { createEmptyDoc, createNode, resolvePaint } from "../src/model";
import { DocStore } from "../src/store";
import { solveLayout } from "../src/layout";

describe("命令系统", () => {
  it("创建 → 撤销 → 重做 后文档状态一致", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const rect = createNode("rect", { name: "R1", width: 10, height: 10 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    expect(store.doc.nodes[rect.id]).toBeTruthy();
    expect(store.doc.nodes[pageId].children).toContain(rect.id);

    store.undo();
    expect(store.doc.nodes[rect.id]).toBeUndefined();
    expect(store.doc.nodes[pageId].children).not.toContain(rect.id);

    store.redo();
    expect(store.doc.nodes[rect.id]).toBeTruthy();
    expect(store.doc.nodes[pageId].children).toContain(rect.id);
  });

  it("删除含子树的画板后撤销可完整恢复", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const child = createNode("rect", { name: "child" });
    const frame = createNode("frame", { name: "F", children: [child.id] });
    child.parentId = frame.id;
    store.apply({ type: "node.create", params: { nodes: [frame, child], parentId: pageId } });

    store.apply({ type: "node.delete", params: { nodeId: frame.id } });
    expect(store.doc.nodes[child.id]).toBeUndefined();

    store.undo();
    expect(store.doc.nodes[frame.id]).toBeTruthy();
    expect(store.doc.nodes[child.id]).toBeTruthy();
    expect(store.doc.nodes[frame.id].children).toContain(child.id);
  });

  it("同一起点应用同一命令序列，结果逐字节相等（确定性）", () => {
    const run = () => {
      const doc = createEmptyDoc();
      // 固定页面 id，排除 id 生成器对确定性比较的干扰
      const page = doc.nodes[doc.rootIds[0]];
      doc.nodes = { p: { ...page, id: "p" } };
      doc.rootIds = ["p"];
      const store = new DocStore(doc);
      const pageId = "p";
      const a = createNode("rect", { id: "a", x: 1, y: 2 });
      const b = createNode("ellipse", { id: "b", x: 3, y: 4 });
      store.apply([
        { type: "node.create", params: { nodes: [a], parentId: pageId } },
        { type: "node.create", params: { nodes: [b], parentId: pageId } },
        { type: "node.update", params: { nodeId: "a", patch: { x: 10 } } },
        { type: "token.define", params: { path: "color/accent", tokenType: "color", values: { light: "#f00" } } },
      ]);
      return JSON.stringify({ nodes: store.doc.nodes, tokens: store.doc.tokens });
    };
    expect(run()).toBe(run());
  });
});

describe("布局求解器（golden）", () => {
  const base = { direction: "horizontal", gap: 10, padding: 0, mainAlign: "start", crossAlign: "start" } as const;

  it("横向排列：固定项按序排布", () => {
    const r = solveLayout(
      { ...base },
      [
        { id: "a", width: 100, height: 50, sizingW: "fixed", sizingH: "fixed" },
        { id: "b", width: 200, height: 80, sizingW: "fixed", sizingH: "fixed" },
      ],
      1000,
      500,
    );
    expect(r).toEqual([
      { id: "a", x: 0, y: 0, width: 100, height: 50 },
      { id: "b", x: 110, y: 0, width: 200, height: 80 },
    ]);
  });

  it("fill 子项均分剩余主轴空间", () => {
    const r = solveLayout(
      { ...base },
      [
        { id: "a", width: 100, height: 50, sizingW: "fixed", sizingH: "fixed" },
        { id: "b", width: 0, height: 50, sizingW: "fill", sizingH: "fixed" },
        { id: "c", width: 0, height: 50, sizingW: "fill", sizingH: "fixed" },
      ],
      310,
      100,
    );
    expect(r[1]).toEqual({ id: "b", x: 110, y: 0, width: 95, height: 50 });
    expect(r[2]).toEqual({ id: "c", x: 215, y: 0, width: 95, height: 50 });
  });

  it("交叉轴居中与 end 对齐", () => {
    const r = solveLayout(
      { ...base, crossAlign: "center" },
      [{ id: "a", width: 100, height: 50, sizingW: "fixed", sizingH: "fixed" }],
      200,
      100,
    );
    expect(r[0].y).toBe(25);
  });

  it("space-between 均分间距", () => {
    const r = solveLayout(
      { ...base, mainAlign: "space-between" },
      [
        { id: "a", width: 50, height: 10, sizingW: "fixed", sizingH: "fixed" },
        { id: "b", width: 50, height: 10, sizingW: "fixed", sizingH: "fixed" },
      ],
      200,
      100,
    );
    expect(r[1].x).toBe(150);
  });
});

describe("Token 解析", () => {
  it("按当前模式解析引用", () => {
    const doc = createEmptyDoc();
    expect(resolvePaint(doc, { token: "color/primary" })).toBe("#3366ff");
    doc.activeMode = "dark";
    expect(resolvePaint(doc, { token: "color/primary" })).toBe("#5b8cff");
    expect(resolvePaint(doc, { value: "#123456" })).toBe("#123456");
  });
});
