import { beforeEach, describe, expect, it } from "vitest";
import { createDocWithPage, createNode } from "@sqraft/core";
import { docStore, ui } from "./store";
import { clampScroll, enterPresenter, exitPresenter, goBack, jumpTo, pageScrollRange, presenterStartPage } from "./presenter";

/** 两页 390×844 的文档；B 页在右侧。 */
function twoPageDoc(): { a: string; b: string } {
  const doc = createDocWithPage("A");
  const a = doc.rootIds[0];
  doc.nodes[a].width = 390;
  doc.nodes[a].height = 844;
  const b = createNode("page", { name: "B", x: 600, y: 0, width: 390, height: 844 });
  doc.nodes[b.id] = b;
  doc.rootIds.push(b.id);
  docStore.replace(doc);
  ui.mode = "edit";
  ui.selection = [];
  ui.activePageId = a;
  ui.presenter = null;
  return { a, b: b.id };
}

beforeEach(() => {
  ui.presenter = null;
});

describe("演示模式：进入与起点", () => {
  it("编辑模式取活动页，返回栈为空", () => {
    const { a } = twoPageDoc();
    enterPresenter();
    expect(ui.presenter).toEqual({ pageId: a, scroll: 0, stack: [] });
  });

  it("拖动模式取选中的页面；没有页面时不进入", () => {
    const { b } = twoPageDoc();
    ui.mode = "pan";
    ui.selection = [b];
    expect(presenterStartPage()).toBe(b);
    enterPresenter();
    expect(ui.presenter).toMatchObject({ pageId: b });

    ui.presenter = null;
    docStore.replace(createDocWithPage("only"));
    ui.selection = [];
    enterPresenter();
    expect(ui.presenter).toMatchObject({ pageId: docStore.doc.rootIds[0] });
  });
});

describe("演示模式：跳转与返回栈", () => {
  it("跳转把当前页与滚动位置入栈，目标是新页且滚动归零", () => {
    const { a, b } = twoPageDoc();
    enterPresenter(a);
    if (ui.presenter) ui.presenter.scroll = 120;

    jumpTo(b);
    expect(ui.presenter).toMatchObject({ pageId: b, scroll: 0 });
    expect(ui.presenter?.stack).toEqual([{ pageId: a, scroll: 120 }]);
  });

  it("返回还原页面与滚动位置，栈空时返回 false", () => {
    const { a, b } = twoPageDoc();
    enterPresenter(a);
    if (ui.presenter) ui.presenter.scroll = 120;
    jumpTo(b);

    expect(goBack()).toBe(true);
    expect(ui.presenter).toMatchObject({ pageId: a, scroll: 120, stack: [] });
    expect(goBack()).toBe(false);
    expect(ui.presenter?.pageId).toBe(a);
  });

  it("退出清空演示状态，不产生命令", () => {
    twoPageDoc();
    enterPresenter();
    const before = docStore.canUndo;
    exitPresenter();
    expect(ui.presenter).toBeNull();
    expect(docStore.canUndo).toBe(before);
  });
});

describe("演示模式：滚动范围", () => {
  it("纵向页按内容超出页面的高度算，并夹在 [0, range]", () => {
    const { a } = twoPageDoc();
    const tall = createNode("rect", { width: 390, height: 1600 });
    docStore.apply({ type: "node.create", params: { nodes: [tall], parentId: a } });
    docStore.apply({ type: "node.update", params: { nodeId: a, patch: { scrollDirection: "vertical" } } });

    const page = docStore.doc.nodes[a];
    expect(pageScrollRange(page)).toBe(756);
    expect(clampScroll(page, 99999)).toBe(756);
    expect(clampScroll(page, -20)).toBe(0);
  });

  it("横向页按内容超出页面的宽度算", () => {
    const { a } = twoPageDoc();
    const wide = createNode("rect", { width: 600, height: 100 });
    docStore.apply({ type: "node.create", params: { nodes: [wide], parentId: a } });
    docStore.apply({ type: "node.update", params: { nodeId: a, patch: { scrollDirection: "horizontal" } } });

    expect(pageScrollRange(docStore.doc.nodes[a])).toBe(210);
  });

  it("内容不超出页面时没有滚动范围", () => {
    const { a } = twoPageDoc();
    const small = createNode("rect", { width: 100, height: 100 });
    docStore.apply({ type: "node.create", params: { nodes: [small], parentId: a } });
    expect(pageScrollRange(docStore.doc.nodes[a])).toBe(0);
  });
});
