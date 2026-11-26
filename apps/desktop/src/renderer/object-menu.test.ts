import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocWithPage, createNode, firstPageId } from "@sqraft/core";
import { closeContextMenu, contextMenu } from "./context-menu";
import { openNodeMenu, openPageMenu } from "./object-menu";
import { docStore, hooks, ui } from "./store";

/** 页面 + 一个矩形：菜单只读文档状态，这里给最小可用的文档。 */
function setup(): { pageId: string; rectId: string } {
  docStore.replace(createDocWithPage());
  const pageId = firstPageId(docStore.doc)!;
  const rect = createNode("rect", { name: "矩形", x: 10, y: 10, width: 50, height: 50 });
  docStore.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
  ui.mode = "edit";
  ui.activePageId = pageId;
  ui.selection = [];
  ui.presenter = null;
  return { pageId, rectId: rect.id };
}

function labels(): string[] {
  return contextMenu.items.map((item) => item.label);
}

beforeEach(() => {
  closeContextMenu();
});

afterEach(() => {
  hooks.copySelectionAs = () => {};
});

describe("右键菜单内容", () => {
  /** 「复制为」子菜单的四个选项。 */
  function copyAsLabels(): string[] {
    const parent = contextMenu.items.find((item) => item.label === "复制为");
    return (parent?.children ?? []).map((item) => item.label);
  }

  it("页面菜单把复制收进「复制为」子菜单", () => {
    const { pageId } = setup();
    openPageMenu(pageId, { x: 0, y: 0 });
    expect(labels()).toEqual(["适配该页", "从这里开始演示", "复制为", "重命名", "删除页面"]);
    expect(copyAsLabels()).toEqual(["PNG 1×", "PNG 2×", "PNG 4×", "SVG"]);
  });

  it("从这里开始演示：以右键的那一页作为起点（不回落活动页）", () => {
    const { pageId } = setup();
    const other = createNode("page", { name: "另一页", x: 600, y: 0, width: 390, height: 844 });
    docStore.apply({ type: "node.create", params: { nodes: [other], parentId: null } });

    openPageMenu(other.id, { x: 0, y: 0 });
    // 菜单打开后活动页可能又变了；菜单项必须用右键的那一页，而不是 presenterStartPage()
    ui.activePageId = pageId;
    contextMenu.items.find((item) => item.label === "从这里开始演示")!.run!();
    expect(ui.presenter).toEqual({ pageId: other.id, scroll: 0, stack: [] });
  });

  it("元素菜单同样收进子菜单", () => {
    const { rectId } = setup();
    openNodeMenu(rectId, { x: 0, y: 0 });
    expect(labels()).toEqual(["复制", "复制为", "布尔运算", "转为路径", "重命名", "删除"]);
    expect(copyAsLabels()).toEqual(["PNG 1×", "PNG 2×", "PNG 4×", "SVG"]);
    // 单选时布尔不可用，转路径可用
    expect(contextMenu.items.find((item) => item.label === "布尔运算")!.disabled).toBe(true);
    expect(contextMenu.items.find((item) => item.label === "转为路径")!.disabled).toBe(false);
  });

  it("两个同级形状选中时布尔子菜单可用，四项都在", () => {
    const { pageId, rectId } = setup();
    const another = createNode("rect", { name: "另一个", x: 100, y: 10, width: 50, height: 50 });
    docStore.apply({ type: "node.create", params: { nodes: [another], parentId: pageId } });
    ui.selection = [rectId, another.id];
    openNodeMenu(rectId, { x: 0, y: 0 });
    const boolean = contextMenu.items.find((item) => item.label === "布尔运算")!;
    expect(boolean.disabled).toBe(false);
    expect((boolean.children ?? []).map((item) => item.label)).toEqual(["并集", "差集", "交集", "排除"]);
  });

  it("页面右键的复制子项走 copySelectionAs，并保持页面选中", () => {
    const { pageId } = setup();
    const copy = vi.fn();
    hooks.copySelectionAs = copy;
    openPageMenu(pageId, { x: 0, y: 0 });
    contextMenu.items.find((item) => item.label === "复制为")!.children![1].run!();
    expect(copy).toHaveBeenCalledWith("png", 2);
    expect(ui.selection).toEqual([pageId]);
  });

  it("多选里右键保持整个选区，重命名置灰", () => {
    const { pageId, rectId } = setup();
    const another = createNode("rect", { name: "另一个", x: 100, y: 10, width: 50, height: 50 });
    docStore.apply({ type: "node.create", params: { nodes: [another], parentId: pageId } });
    ui.selection = [rectId, another.id];
    openNodeMenu(rectId, { x: 0, y: 0 });
    expect(ui.selection).toEqual([rectId, another.id]);
    expect(contextMenu.items.find((item) => item.label === "重命名")!.disabled).toBe(true);
  });
});
