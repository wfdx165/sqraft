import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, createLayoutSpec, type LayoutSpec, type NodeStyle } from "../src/model";
import { DocStore } from "../src/store";
import { NUMERIC_TOKEN_CHANGED } from "../src/token-commands";
import { planTokenDelete, tokenRefsOf } from "../src/token-refs";
import { resolveNumericLayout, resolveNumericStyle } from "../src/token-resolve";

function setup() {
  const store = new DocStore(createDocWithPage());
  const pageId = store.doc.rootIds[0];
  store.apply({ type: "node.update", params: { nodeId: pageId, patch: { width: 400, height: 400 } } });
  return { store, pageId };
}

function defineNumber(store: DocStore, path: string, value: number) {
  store.apply({ type: "token.define", params: { path, tokenType: "number", value } }, "token");
}

describe("数值 Token：读时解析", () => {
  it("单值 Token 覆盖字面量；缺失或类型不对回退", () => {
    const { store } = setup();
    defineNumber(store, "size/body", 18);
    store.doc.tokens["color/x"] = { type: "color", value: "#fff" };

    const resolved = resolveNumericStyle(store.doc, {
      fontSize: 12,
      fontSizeToken: "size/body",
      lineHeight: 20,
      lineHeightToken: "size/missing",
      strokeWidth: 3,
      strokeWidthToken: "color/x",
    });
    expect(resolved.fontSize).toBe(18);
    expect(resolved.lineHeight).toBe(20);
    expect(resolved.strokeWidth).toBe(3);

    const negative = resolveNumericStyle(store.doc, { strokeWidth: 3, strokeWidthToken: "size/negative" });
    defineNumber(store, "size/negative", -5);
    expect(resolveNumericStyle(store.doc, negative).strokeWidth).toBe(0);
  });

  it("逐角圆角与逐边内边距只覆盖绑定的角/边", () => {
    const { store } = setup();
    defineNumber(store, "radius/sm", 4);
    defineNumber(store, "space/md", 16);

    const style: NodeStyle = {
      cornerRadius: { topLeft: 1, topRight: 2, bottomRight: 3, bottomLeft: 4 },
      cornerRadiusTokens: { topLeft: "radius/sm", bottomRight: "radius/sm" },
    };
    expect(resolveNumericStyle(store.doc, style).cornerRadius).toEqual({
      topLeft: 4,
      topRight: 2,
      bottomRight: 4,
      bottomLeft: 4,
    });

    const layout: LayoutSpec = createLayoutSpec({
      gap: 8,
      padding: { top: 1, right: 2, bottom: 3, left: 4 },
      gapToken: "space/md",
      paddingTokens: { top: "space/md", left: "space/md" },
    });
    const resolved = resolveNumericLayout(store.doc, layout);
    expect(resolved.gap).toBe(16);
    expect(resolved.padding).toEqual({ top: 16, right: 2, bottom: 3, left: 16 });
  });
});

describe("数值 Token：布局联动", () => {
  it("gap Token 驱动自动布局；改值与撤销都重新求解", () => {
    const { store } = setup();
    const pageId = store.doc.rootIds[0];
    defineNumber(store, "space/md", 20);

    const frame = createNode("frame", {
      name: "容器",
      parentId: pageId,
      x: 0,
      y: 0,
      width: 300,
      height: 300,
      layout: createLayoutSpec({ direction: "vertical", gap: 0 }),
    });
    const a = createNode("rect", { name: "A", parentId: frame.id, width: 50, height: 50 });
    const b = createNode("rect", { name: "B", parentId: frame.id, width: 50, height: 50 });
    frame.children = [a.id, b.id];
    store.apply({ type: "node.create", params: { nodes: [frame, a, b], parentId: pageId } });

    store.apply(
      { type: "node.update", params: { nodeId: frame.id, patch: { layout: { ...frame.layout!, gapToken: "space/md" } } } },
      "bind",
    );
    expect([store.doc.nodes[b.id].x, store.doc.nodes[b.id].y]).toEqual([0, 70]);

    defineNumber(store, "space/md", 40);
    expect([store.doc.nodes[b.id].x, store.doc.nodes[b.id].y]).toEqual([0, 90]);

    store.undo();
    expect([store.doc.nodes[b.id].x, store.doc.nodes[b.id].y]).toEqual([0, 70]);
    store.undo();
    expect([store.doc.nodes[b.id].x, store.doc.nodes[b.id].y]).toEqual([0, 50]);
  });

  it("改值标记引用节点；tokenRefsOf 能列出 style 与 layout 两处引用", () => {
    const { store, pageId } = setup();
    defineNumber(store, "space/md", 20);
    const node = createNode("frame", {
      name: "F",
      parentId: pageId,
      style: { fontSizeToken: "space/md" },
      layout: createLayoutSpec({ gapToken: "space/md", paddingTokens: { top: "space/md" } }),
    });
    store.apply({ type: "node.create", params: { nodes: [node], parentId: pageId } });
    expect(tokenRefsOf(store.doc, "space/md")).toEqual([node.id]);
  });
});

describe("数值 Token：改名与删除", () => {
  it("rename 同步 style / layout / 覆盖表", () => {
    const { store, pageId } = setup();
    defineNumber(store, "size/a", 16);
    const node = createNode("frame", {
      name: "F",
      parentId: pageId,
      style: { fontSizeToken: "size/a", cornerRadiusTokens: { topLeft: "size/a" } },
      layout: createLayoutSpec({ gapToken: "size/a", paddingTokens: { left: "size/a" } }),
    });
    store.apply({ type: "node.create", params: { nodes: [node], parentId: pageId } });
    // 覆盖表是另一份持久化差异：直接造一条，确认改名一起改
    store.doc.nodes[node.id].overrides = {
      main: { style: { fontSizeToken: "size/a" }, layout: { ...createLayoutSpec(), gapToken: "size/a" } },
    };

    store.apply({ type: "token.rename", params: { from: "size/a", to: "size/b" } }, "rename");

    const next = store.doc.nodes[node.id];
    expect(next.style.fontSizeToken).toBe("size/b");
    expect(next.style.cornerRadiusTokens?.topLeft).toBe("size/b");
    expect(next.layout?.gapToken).toBe("size/b");
    expect(next.layout?.paddingTokens?.left).toBe("size/b");
    expect(next.overrides?.main.style?.fontSizeToken).toBe("size/b");
    expect(next.overrides?.main.layout?.gapToken).toBe("size/b");
  });

  it("delete + detach 把逐角/逐边引用冻结成当前值，撤销后恢复", () => {
    const { store, pageId } = setup();
    defineNumber(store, "size/a", 10);
    const node = createNode("frame", {
      name: "F",
      parentId: pageId,
      style: {
        fontSize: 12,
        fontSizeToken: "size/a",
        cornerRadius: { topLeft: 1, topRight: 2, bottomRight: 3, bottomLeft: 4 },
        cornerRadiusTokens: { topLeft: "size/a", bottomRight: "size/a" },
      },
      layout: createLayoutSpec({
        gap: 2,
        gapToken: "size/a",
        padding: { top: 1, right: 2, bottom: 3, left: 4 },
        paddingTokens: { top: "size/a", left: "size/a" },
      }),
    });
    store.apply({ type: "node.create", params: { nodes: [node], parentId: pageId } });

    const plan = planTokenDelete(store.doc, "size/a", true);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    store.apply(plan.commands, "delete-token");

    const next = store.doc.nodes[node.id];
    expect(store.doc.tokens["size/a"]).toBeUndefined();
    expect(next.style.fontSizeToken).toBeUndefined();
    expect(next.style.fontSize).toBe(10);
    expect(next.style.cornerRadius).toEqual({ topLeft: 10, topRight: 2, bottomRight: 10, bottomLeft: 4 });
    expect(next.style.cornerRadiusTokens).toBeUndefined();
    expect(next.layout?.gapToken).toBeUndefined();
    expect(next.layout?.gap).toBe(10);
    expect(next.layout?.padding).toEqual({ top: 10, right: 2, bottom: 3, left: 10 });
    expect(next.layout?.paddingTokens).toBeUndefined();

    store.undo();
    const restored = store.doc.nodes[node.id];
    expect(store.doc.tokens["size/a"]).toEqual({ type: "number", value: 10 });
    expect(restored.style.fontSizeToken).toBe("size/a");
    expect(restored.style.cornerRadiusTokens?.topLeft).toBe("size/a");
    expect(restored.layout?.paddingTokens?.left).toBe("size/a");
  });
});

describe("数值 Token：边界与标记", () => {
  it("字号 Token 非正数时回退字面量；逐边 padding Token 参与布局", () => {
    const { store, pageId } = setup();
    defineNumber(store, "size/zero", 0);
    expect(resolveNumericStyle(store.doc, { fontSize: 12, fontSizeToken: "size/zero" }).fontSize).toBe(12);

    defineNumber(store, "space/md", 24);
    const frame = createNode("frame", {
      name: "F",
      parentId: pageId,
      x: 0,
      y: 0,
      width: 300,
      height: 300,
      layout: createLayoutSpec({
        direction: "vertical",
        gap: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        paddingTokens: { top: "space/md" },
      }),
    });
    const child = createNode("rect", { name: "C", parentId: frame.id, width: 50, height: 50 });
    frame.children = [child.id];
    store.apply({ type: "node.create", params: { nodes: [frame, child], parentId: pageId } });
    expect(store.doc.nodes[child.id].y).toBe(24);
  });

  it("数值 define 才带 NUMERIC_TOKEN_CHANGED 标记", () => {
    const { store } = setup();
    const marks: Array<boolean> = [];
    const stop = store.subscribe((_state, changed) => marks.push(changed.has(NUMERIC_TOKEN_CHANGED)));
    defineNumber(store, "space/a", 10);
    store.doc.tokens["color/a"] = { type: "color", value: "#000" };
    store.apply({ type: "token.define", params: { path: "color/a", tokenType: "color", value: "#111" } }, "token");
    stop();
    expect(marks).toEqual([true, false]);
  });
});
