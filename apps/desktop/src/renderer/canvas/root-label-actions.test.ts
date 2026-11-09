import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocWithPage, createNode, DocStore, firstPageId, type NodeId } from "@sqraft/core";
import type { Viewport } from "@sqraft/render";
import { docStore, ui } from "../store";
import {
  beginRootLabelDrag,
  beginRootLabelRename,
  rootLabelAtPointer,
  rootLabelHover,
  rootLabelMenuKind,
} from "./root-label-actions";

const vp: Viewport = { x: 0, y: 0, zoom: 1, width: 1200, height: 900, dpr: 1 };

/** 页面 (0,0) 400×400 + 页面右侧的母版 (600,40)。 */
function setup(): { pageId: NodeId; masterId: NodeId } {
  const store = new DocStore(createDocWithPage());
  store.apply({ type: "node.update", params: { nodeId: store.doc.rootIds[0], patch: { width: 400, height: 400 } } });
  docStore.replace(store.doc);
  const pageId = firstPageId(docStore.doc)!;
  const frame = createNode("frame", { name: "卡片", x: 600, y: 40, width: 200, height: 100 });
  docStore.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
  docStore.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
  ui.mode = "edit";
  ui.tool = "select";
  ui.activePageId = pageId;
  ui.selection = [];
  ui.expandedPageId = pageId;
  return { pageId, masterId: frame.id };
}

describe("根节点标签的交互", () => {
  beforeEach(() => {
    ui.selection = [];
    ui.instanceContext = [];
  });

  it("按下母版标签只改选区，不写 activePageId / expandedPageId", () => {
    const { pageId, masterId } = setup();
    const setActivePage = vi.fn();
    beginRootLabelDrag(docStore.doc.nodes[masterId], { setActivePage });
    expect(ui.selection).toEqual([masterId]);
    expect(setActivePage).not.toHaveBeenCalled();
    expect(ui.activePageId).toBe(pageId);
    expect(ui.expandedPageId).toBe(pageId);
  });

  it("按下页面标签会切活动页并展开左栏", () => {
    const { pageId } = setup();
    const second = createNode("page", { name: "第二页", x: 0, y: 800, width: 400, height: 300 });
    docStore.apply({ type: "node.create", params: { nodes: [second], parentId: null } });
    const setActivePage = vi.fn();
    beginRootLabelDrag(docStore.doc.nodes[second.id], { setActivePage });
    expect(setActivePage).toHaveBeenCalledWith(second.id);
    expect(ui.expandedPageId).toBe(second.id);
    expect(ui.selection).toEqual([second.id]);
    // 点当前页不重复切页
    setActivePage.mockClear();
    beginRootLabelDrag(docStore.doc.nodes[pageId], { setActivePage });
    expect(setActivePage).not.toHaveBeenCalled();
  });

  it("双击母版标签只改名，双击页面标签先切页", () => {
    const { pageId, masterId } = setup();
    const setActivePage = vi.fn();
    const startRename = vi.fn();
    beginRootLabelRename(docStore.doc.nodes[masterId], { setActivePage, startRename });
    expect(startRename).toHaveBeenCalledWith(docStore.doc.nodes[masterId]);
    expect(setActivePage).not.toHaveBeenCalled();

    const second = createNode("page", { name: "第二页", x: 0, y: 800, width: 400, height: 300 });
    docStore.apply({ type: "node.create", params: { nodes: [second], parentId: null } });
    startRename.mockClear();
    beginRootLabelRename(docStore.doc.nodes[second.id], { setActivePage, startRename });
    expect(setActivePage).toHaveBeenCalledWith(second.id);
    expect(startRename).toHaveBeenCalledTimes(1);
    expect(ui.activePageId).toBe(pageId);
  });

  it("悬停：母版标签点亮母版的紫色框，页面标签不带库对象", () => {
    const { pageId, masterId } = setup();
    const master = docStore.doc.nodes[masterId];
    expect(rootLabelHover(master, null)).toEqual({ onLabel: true, libraryId: masterId });
    expect(rootLabelHover(docStore.doc.nodes[pageId], null)).toEqual({ onLabel: true, libraryId: null });
    // 标签之外仍按命中的库对象走
    expect(rootLabelHover(null, master)).toEqual({ onLabel: false, libraryId: masterId });
    expect(rootLabelHover(null, docStore.doc.nodes[pageId])).toEqual({ onLabel: false, libraryId: null });
  });

  it("右键标签：页面弹页面菜单，母版弹节点菜单", () => {
    const { pageId, masterId } = setup();
    expect(rootLabelMenuKind(docStore.doc.nodes[pageId])).toBe("page");
    expect(rootLabelMenuKind(docStore.doc.nodes[masterId])).toBe("node");
  });

  it("钢笔草稿期间标签不参与命中", () => {
    const { masterId } = setup();
    ui.tool = "path";
    expect(rootLabelAtPointer(vp, null, 600, 20, true)).toBeNull();
    expect(rootLabelAtPointer(vp, null, 600, 20, false)?.id).toBe(masterId);
    // 选了别的工具（哪怕草稿还在）：标签照常可抓
    ui.tool = "select";
    expect(rootLabelAtPointer(vp, null, 600, 20, true)?.id).toBe(masterId);
  });
});
