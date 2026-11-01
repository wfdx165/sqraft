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
  return { pageId, rectId: rect.id };
}

function labels(): string[] {
  return contextMenu.items.map((item) => item.label);
}

beforeEach(() => {
  closeContextMenu();
});

afterEach(() => {
  hooks.copySelectionPng = () => {};
});

describe("右键菜单内容", () => {
  it("页面菜单用「复制为 PNG」替代导出", () => {
    const { pageId } = setup();
    openPageMenu(pageId, { x: 0, y: 0 });
    expect(labels()).toEqual(["适配该页", "复制为 PNG", "重命名", "删除页面"]);
    expect(labels()).not.toContain("导出 PNG…");
  });

  it("元素菜单保留复制，去掉导出", () => {
    const { rectId } = setup();
    openNodeMenu(rectId, { x: 0, y: 0 });
    expect(labels()).toEqual(["复制", "复制为 PNG", "重命名", "删除"]);
    expect(labels()).not.toContain("导出 PNG…");
  });

  it("页面右键的复制项走 copySelectionPng，并保持页面选中", () => {
    const { pageId } = setup();
    const copy = vi.fn();
    hooks.copySelectionPng = copy;
    openPageMenu(pageId, { x: 0, y: 0 });
    contextMenu.items.find((item) => item.label === "复制为 PNG")!.run();
    expect(copy).toHaveBeenCalledTimes(1);
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
