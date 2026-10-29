import { describe, expect, it } from "vitest";
import {
  createEmptyDoc,
  createNode,
  resolvePaint,
  worldRect,
  nextPagePosition,
  DEFAULT_PAGE_WIDTH,
  PAGE_GAP,
} from "../src/model";
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
        { type: "token.define", params: { path: "color/accent", tokenType: "color", value: "#f00" } },
      ]);
      return JSON.stringify({ nodes: store.doc.nodes, tokens: store.doc.tokens });
    };
    expect(run()).toBe(run());
  });
});

describe("Token 改名", () => {
  it("改名后节点引用跟随，撤销后路径与引用双双还原", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const rect = createNode("rect", { name: "R", style: { fill: { token: "color/primary" }, stroke: { token: "color/primary" } } });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });

    store.apply({ type: "token.rename", params: { from: "color/primary", to: "brand/primary" } });
    expect(store.doc.tokens["color/primary"]).toBeUndefined();
    expect(store.doc.tokens["brand/primary"]).toEqual({ type: "color", value: "#3366ff" });
    expect(store.doc.nodes[rect.id].style.fill?.token).toBe("brand/primary");
    expect(store.doc.nodes[rect.id].style.stroke?.token).toBe("brand/primary");
    // 改名不改变渲染结果
    expect(resolvePaint(store.doc, store.doc.nodes[rect.id].style.fill)).toBe("#3366ff");

    store.undo();
    expect(store.doc.tokens["brand/primary"]).toBeUndefined();
    expect(store.doc.tokens["color/primary"]).toEqual({ type: "color", value: "#3366ff" });
    expect(store.doc.nodes[rect.id].style.fill?.token).toBe("color/primary");
    expect(store.doc.nodes[rect.id].style.stroke?.token).toBe("color/primary");

    store.redo();
    expect(store.doc.tokens["brand/primary"]).toBeTruthy();
    expect(store.doc.nodes[rect.id].style.fill?.token).toBe("brand/primary");
  });

  it("只改引用了该 Token 的节点，其它节点不动", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const a = createNode("rect", { name: "A", style: { fill: { token: "color/text" } } });
    const b = createNode("rect", { name: "B", style: { fill: { token: "color/primary" } } });
    store.apply([
      { type: "node.create", params: { nodes: [a], parentId: pageId } },
      { type: "node.create", params: { nodes: [b], parentId: pageId } },
    ]);

    store.apply({ type: "token.rename", params: { from: "color/text", to: "ink/text" } });
    expect(store.doc.nodes[a.id].style.fill?.token).toBe("ink/text");
    expect(store.doc.nodes[b.id].style.fill?.token).toBe("color/primary");
  });

  it("源不存在或目标重名时抛错且不改文档", () => {
    const store = new DocStore(createEmptyDoc());
    const before = JSON.stringify(store.doc.tokens);
    expect(() => store.apply({ type: "token.rename", params: { from: "color/nope", to: "x/y" } })).toThrow();
    expect(() => store.apply({ type: "token.rename", params: { from: "color/primary", to: "color/text" } })).toThrow();
    expect(() => store.apply({ type: "token.rename", params: { from: "color/primary", to: "color/primary" } })).toThrow();
    expect(JSON.stringify(store.doc.tokens)).toBe(before);
    // 失败不占撤销记录
    expect(store.canUndo).toBe(false);
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
  it("解析引用与字面量；缺失 Token 以示警色返回", () => {
    const doc = createEmptyDoc();
    expect(resolvePaint(doc, { token: "color/primary" })).toBe("#3366ff");
    expect(resolvePaint(doc, { value: "#123456" })).toBe("#123456");
    expect(resolvePaint(doc, { token: "color/missing" })).toBe("#ff00ff");
  });
});

describe("页面与世界坐标", () => {
  it("worldRect 累加页面与容器偏移", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const frame = createNode("frame", { x: 100, y: 50 });
    const rect = createNode("rect", { x: 10, y: 20 });
    rect.parentId = frame.id;
    frame.children = [rect.id];
    store.apply({ type: "node.create", params: { nodes: [frame, rect], parentId: pageId } });
    const r = worldRect(store.doc, rect.id);
    expect(r).toMatchObject({ x: 110, y: 70, width: rect.width, height: rect.height });
  });

  it("nextPagePosition 放在最右侧页面之右", () => {
    const store = new DocStore(createEmptyDoc());
    expect(nextPagePosition(store.doc)).toEqual({ x: DEFAULT_PAGE_WIDTH + PAGE_GAP, y: 0 });
  });
});
