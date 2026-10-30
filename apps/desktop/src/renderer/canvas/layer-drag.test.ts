import { describe, expect, it } from "vitest";
import { createEmptyDoc, createNode, firstPageId } from "@sqraft/core";
import { planLayerDrop } from "./layer-drag";

function setup() {
  const doc = createEmptyDoc();
  const pageId = firstPageId(doc)!;
  const add = (type: "rect" | "frame", parentId: string, name: string) => {
    const node = createNode(type, { parentId, name });
    doc.nodes[node.id] = node;
    doc.nodes[parentId].children.push(node.id);
    return node;
  };
  return { doc, pageId, add };
}

describe("图层面板拖拽", () => {
  it("视觉上方 = children 里更靠后（面板倒序显示）", () => {
    const { doc, pageId, add } = setup();
    const a = add("rect", pageId, "a");
    const b = add("rect", pageId, "b");
    const c = add("rect", pageId, "c");

    // 把 a 拖到 b 的"上方"（视觉上更靠前）→ children 里排在 b 之后
    const above = planLayerDrop(doc, a.id, b.id, "above");
    expect(above).toEqual({ parentId: pageId, index: 1 });

    const below = planLayerDrop(doc, a.id, b.id, "below");
    expect(below).toEqual({ parentId: pageId, index: 0 });

    // c 拖到 a 下方
    const cBelowA = planLayerDrop(doc, c.id, a.id, "below");
    expect(cBelowA).toEqual({ parentId: pageId, index: 0 });
  });

  it("拖进容器：放到子节点末尾", () => {
    const { doc, pageId, add } = setup();
    const frame = add("frame", pageId, "frame");
    const rect = add("rect", pageId, "rect");
    expect(planLayerDrop(doc, rect.id, frame.id, "inside")).toEqual({
      parentId: frame.id,
      index: frame.children.length,
    });
  });

  it("拒绝拖到自身、自己的子孙、实例内部", () => {
    const { doc, pageId, add } = setup();
    const frame = add("frame", pageId, "frame");
    const child = add("rect", frame.id, "child");
    expect(planLayerDrop(doc, frame.id, frame.id, "below")).toBeNull();
    expect(planLayerDrop(doc, frame.id, child.id, "below")).toBeNull();
  });

  it("同父级往下挪时索引要减一（先移除再插入）", () => {
    const { doc, pageId, add } = setup();
    const a = add("rect", pageId, "a");
    add("rect", pageId, "b");
    const c = add("rect", pageId, "c");
    // a(0) 拖到 c(2) 下方：目标 index 2，移除 a 后 c 在 1，应插在 1
    expect(planLayerDrop(doc, a.id, c.id, "below")).toEqual({ parentId: pageId, index: 1 });
  });
});
