import { beforeEach, describe, expect, it } from "vitest";
import { createDocWithPage, createNode, DocStore, firstPageId, type NodeId } from "@sqraft/core";
import type { Viewport } from "@sqraft/render";
import { docStore, ui } from "../store";
import { LABEL_CHIP_MIN_Y, labelChipWidth } from "./label-metrics";
import { labelAt, labelOrigin, rootLabelRect } from "./labels";

const vp: Viewport = { x: 0, y: 0, zoom: 1, width: 1200, height: 900, dpr: 1 };

/**
 * 页面 0,0 起 400×400；母版在页面右侧 (600,40)，且子节点铺满整个矩形——
 * 这正是「画布上没有像素能命中母版本体」的场景。
 */
function setup(): { pageId: NodeId; masterId: NodeId; coverId: NodeId } {
  const store = new DocStore(createDocWithPage());
  store.apply({ type: "node.update", params: { nodeId: store.doc.rootIds[0], patch: { width: 400, height: 400 } } });
  docStore.replace(store.doc);
  const pageId = firstPageId(docStore.doc)!;
  const frame = createNode("frame", { name: "卡片", x: 600, y: 40, width: 200, height: 100 });
  docStore.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
  docStore.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
  const cover = createNode("rect", { name: "底色", x: 0, y: 0, width: 200, height: 100 });
  docStore.apply({ type: "node.create", params: { nodes: [cover], parentId: frame.id } });
  ui.mode = "edit";
  ui.activePageId = pageId;
  return { pageId, masterId: frame.id, coverId: cover.id };
}

describe("根节点名称标签", () => {
  beforeEach(() => {
    ui.selection = [];
    ui.tool = "select";
  });

  it("母版子节点铺满时，标签仍能命中母版", () => {
    const { masterId } = setup();
    // 母版左上 (600,40)：标签 chip 顶边 = 40-26 = 14、左边 = 594
    const hit = labelAt(600, 20, vp, null);
    expect(hit?.id).toBe(masterId);
    expect(hit?.type).toBe("component");
  });

  it("页面标签照旧命中页面", () => {
    const { pageId } = setup();
    const rect = rootLabelRect(docStore.doc.nodes[pageId], vp, null);
    expect(rect).not.toBeNull();
    const hit = labelAt(rect!.x + 10, rect!.y + rect!.height / 2, vp, null);
    expect(hit?.id).toBe(pageId);
    expect(hit?.type).toBe("page");
  });

  it("标签矩形包含图标占位，名称越长越宽", () => {
    const { masterId } = setup();
    const node = docStore.doc.nodes[masterId];
    const rect = rootLabelRect(node, vp, null)!;
    expect(rect.width).toBe(labelChipWidth(node.name.length * 11));
    const renamed = { ...node, name: `${node.name}状态栏` };
    expect(rootLabelRect(renamed, vp, null)!.width - rect.width).toBe(3 * 11);
  });

  it("隐藏的母版不画标签、也不可点", () => {
    const { masterId } = setup();
    docStore.apply({ type: "node.update", params: { nodeId: masterId, patch: { visible: false } } });
    expect(labelAt(600, 20, vp, null)).toBeNull();
  });

  it("对象整块在视口上方时没有标签；露出一点时标签夹在视口顶部", () => {
    const { masterId } = setup();
    const node = docStore.doc.nodes[masterId];
    docStore.apply({ type: "node.update", params: { nodeId: masterId, patch: { y: -200 } } });
    expect(rootLabelRect({ ...node, y: -200 }, vp, null)).toBeNull();
    expect(labelAt(600, 20, vp, null)).toBeNull();

    // 上半在视口外、下半看得见：标签贴到视口顶，仍可抓
    docStore.apply({ type: "node.update", params: { nodeId: masterId, patch: { y: -40 } } });
    const rect = rootLabelRect(docStore.doc.nodes[masterId], vp, null)!;
    expect(rect.y).toBe(LABEL_CHIP_MIN_Y);
    expect(labelAt(600, LABEL_CHIP_MIN_Y + 4, vp, null)?.id).toBe(masterId);
  });

  it("拖动母版时标签跟着偏移（不改文档）", () => {
    const { masterId } = setup();
    const node = docStore.doc.nodes[masterId];
    const drag = { mode: "move", moved: true, offsetX: 30, offsetY: 10 };
    expect(labelOrigin(node, { drag, resizePreview: null, selection: [masterId] })).toEqual({ x: 630, y: 50 });
    // 没被选中 / 还没真正拖动：标签留在原位
    expect(labelOrigin(node, { drag, resizePreview: null, selection: [] })).toEqual({ x: 600, y: 40 });
    expect(
      labelOrigin(node, { drag: { ...drag, moved: false }, resizePreview: null, selection: [masterId] }),
    ).toEqual({ x: 600, y: 40 });
  });
});
