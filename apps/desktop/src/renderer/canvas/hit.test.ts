import { beforeEach, describe, expect, it } from "vitest";
import { createDocWithPage, createNode, DocStore, firstPageId, type NodeId } from "@sqraft/core";
import type { Viewport } from "@sqraft/render";
import { docStore, ui } from "../store";
import { hitTest, pageAt } from "./hit";

const vp: Viewport = { x: 0, y: 0, zoom: 1, width: 800, height: 600, dpr: 1 };

/** 页面 0,0 起 400×400；母版放在页面右侧、不与页面重叠。 */
function setup(): { pageId: NodeId; masterId: NodeId } {
  const store = new DocStore(createDocWithPage());
  store.apply({ type: "node.update", params: { nodeId: store.doc.rootIds[0], patch: { width: 400, height: 400 } } });
  docStore.replace(store.doc);
  const pageId = firstPageId(docStore.doc)!;
  const frame = createNode("frame", { name: "卡片", x: 600, y: 40, width: 200, height: 100 });
  docStore.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
  docStore.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
  ui.mode = "edit";
  ui.activePageId = pageId;
  ui.instanceContext = [];
  return { pageId, masterId: frame.id };
}

describe("画布命中：主组件是文档根节点", () => {
  beforeEach(() => {
    ui.selection = [];
  });

  it("母版可以点选，命中的是母版本身", () => {
    const { masterId, pageId } = setup();
    const hit = hitTest(vp, 700, 90);
    expect(hit?.id).toBe(masterId);
    // 母版不属于任何页面：命中不切活动页
    expect(hit?.inactive).toBe(false);
    expect(hit?.pageId).toBe(pageId);
  });

  it("母版空白处也给母版（与页面空白处给页面一致）", () => {
    const { masterId } = setup();
    expect(hitTest(vp, 795, 135)?.id).toBe(masterId);
  });

  it("母版关掉裁剪后，越界子节点仍可点中", () => {
    const { masterId } = setup();
    docStore.apply({ type: "node.update", params: { nodeId: masterId, patch: { clip: false } } });
    // 子节点故意伸出母版右边界（母版 x 600..800，子节点到 860）
    const over = createNode("rect", {
      name: "溢出块",
      x: 200,
      y: 10,
      width: 60,
      height: 40,
      style: { fill: { value: "#3366ff" } },
    });
    docStore.apply({ type: "node.create", params: { nodes: [over], parentId: masterId } });
    // 点在母版矩形之外、子节点矩形之内（世界坐标 860 附近）
    expect(hitTest(vp, 840, 90)?.id).toBe(over.id);
  });

  it("页面区域仍然命中页面，pageAt 不把母版当页面", () => {
    const { pageId, masterId } = setup();
    expect(hitTest(vp, 100, 100)?.id).toBe(pageId);
    expect(pageAt(700, 90)).toBeNull();
    expect(pageAt(700, 90)).not.toBe(masterId);
  });
});
