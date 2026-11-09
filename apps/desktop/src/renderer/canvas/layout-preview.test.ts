import { beforeEach, describe, expect, it } from "vitest";
import { createDocWithPage, createLayoutSpec, createNode, DocStore, firstPageId, type NodeId } from "@sqraft/core";
import { docStore } from "../store";
import { buildInsertPreview } from "./layout-preview";

let frameId: NodeId;
let firstId: NodeId;
let movingId: NodeId;

beforeEach(() => {
  docStore.replace(new DocStore(createDocWithPage()).doc);
  const pageId = firstPageId(docStore.doc)!;
  docStore.apply({ type: "token.define", params: { path: "space/md", tokenType: "number", value: 20 } }, "token");

  const frame = createNode("frame", {
    name: "容器",
    parentId: pageId,
    x: 0,
    y: 0,
    width: 300,
    height: 300,
    layout: createLayoutSpec({ direction: "vertical", gap: 0, gapToken: "space/md" }),
  });
  const first = createNode("rect", { name: "A", parentId: frame.id, width: 50, height: 50 });
  const moving = createNode("rect", { name: "C", parentId: frame.id, width: 50, height: 50 });
  frame.children = [first.id, moving.id];
  docStore.apply({ type: "node.create", params: { nodes: [frame, first, moving], parentId: pageId } });

  frameId = frame.id;
  firstId = first.id;
  movingId = moving.id;
});

describe("自动布局让位预览", () => {
  it("使用解析后的 gap Token 计算预览位置", () => {
    // 初始布局（gap 20）：A y=0、C y=70
    expect(docStore.doc.nodes[movingId].y).toBe(70);

    // 把 C 拖到最前面：A 应让到 50 + 20 = 70（用字面量 gap 0 会算成 50）
    const preview = buildInsertPreview(frameId, 0, [movingId])!;
    expect(preview.get(firstId)?.y).toBe(70);
  });
});
