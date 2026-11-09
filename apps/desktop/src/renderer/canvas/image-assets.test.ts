import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, type DocNode, type DocState } from "@sqraft/core";
import { imageAssetIds } from "./image-assets";

function attach(doc: DocState, parentId: string, node: DocNode): DocNode {
  node.parentId = parentId;
  doc.nodes[node.id] = node;
  doc.nodes[parentId].children.push(node.id);
  return node;
}

function imageNode(assetId: string, x: number, y: number, width = 100, height = 100): DocNode {
  return createNode("image", {
    x,
    y,
    width,
    height,
    image: { assetId, naturalWidth: width, naturalHeight: height, crop: { x: 0, y: 0, width, height } },
  });
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

describe("渲染用图片资源收集", () => {
  it("页面背景图与图片节点都会收集（含嵌套）", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    doc.nodes[pageId].backgroundImage = { assetId: "bg", fit: "cover" };
    attach(doc, pageId, imageNode("a1", 10, 10));
    const frame = attach(doc, pageId, createNode("frame", { x: 300, y: 300, width: 200, height: 200 }));
    attach(doc, frame.id, imageNode("a2", 20, 20));
    expect(sorted(imageAssetIds(doc))).toEqual(["a1", "a2", "bg"]);
  });

  it("给 region 时只收集与区域相交的图片", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    attach(doc, pageId, imageNode("left", 10, 10));
    attach(doc, pageId, imageNode("right", 600, 10));
    expect(sorted(imageAssetIds(doc, { region: { x: 0, y: 0, width: 200, height: 200 } }))).toEqual(["left"]);
    expect(sorted(imageAssetIds(doc, { region: { x: 500, y: 0, width: 300, height: 200 } }))).toEqual(["right"]);
    expect(imageAssetIds(doc, { region: { x: 2000, y: 2000, width: 100, height: 100 } })).toEqual([]);
  });

  it("旋转图片按旋转后的包围盒判断相交", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    // 100×100 绕中心旋转 45°：外接盒约从 79.3 到 220.7，未旋转时从 100 开始
    attach(doc, pageId, createNode("image", {
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      rotation: 45,
      image: { assetId: "rot", naturalWidth: 100, naturalHeight: 100, crop: { x: 0, y: 0, width: 100, height: 100 } },
    }));
    expect(imageAssetIds(doc, { region: { x: 76, y: 145, width: 10, height: 10 } })).toEqual(["rot"]);
    expect(imageAssetIds(doc, { region: { x: 20, y: 145, width: 10, height: 10 } })).toEqual([]);
  });

  it("nodeIds 只收集这些子树里的图片", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const frame = attach(doc, pageId, createNode("frame", { x: 300, y: 300, width: 200, height: 200 }));
    attach(doc, frame.id, imageNode("inside", 10, 10));
    attach(doc, pageId, imageNode("outside", 0, 0));
    expect(imageAssetIds(doc, { nodeIds: [frame.id] })).toEqual(["inside"]);
  });

  it("pageId 只收集该页的背景图与子树图片", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    doc.nodes[pageId].backgroundImage = { assetId: "bg1", fit: "cover" };
    attach(doc, pageId, imageNode("p1", 10, 10));
    const second = createNode("page", { x: 2000, y: 0, width: 1440, height: 1024 });
    doc.rootIds.push(second.id);
    doc.nodes[second.id] = second;
    second.backgroundImage = { assetId: "bg2", fit: "cover" };
    attach(doc, second.id, imageNode("p2", 10, 10));

    expect(sorted(imageAssetIds(doc, { pageId }))).toEqual(["bg1", "p1"]);
    expect(sorted(imageAssetIds(doc, { pageId: second.id }))).toEqual(["bg2", "p2"]);
  });

  it("页面背景图也按 region 过滤", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    doc.nodes[pageId].backgroundImage = { assetId: "bg1", fit: "cover" };
    const second = createNode("page", { x: 2000, y: 0, width: 1440, height: 1024 });
    doc.rootIds.push(second.id);
    doc.nodes[second.id] = second;

    expect(imageAssetIds(doc, { region: { x: 10, y: 10, width: 100, height: 100 } })).toEqual(["bg1"]);
    expect(imageAssetIds(doc, { region: { x: 2100, y: 10, width: 100, height: 100 } })).toEqual([]);
  });

  it("隐藏图片不参与解码", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    attach(doc, pageId, createNode("image", {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      visible: false,
      image: { assetId: "hidden", naturalWidth: 10, naturalHeight: 10, crop: { x: 0, y: 0, width: 10, height: 10 } },
    }));
    expect(imageAssetIds(doc)).toEqual([]);
  });
});
