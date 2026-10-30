import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, type DocNode, type DocState } from "@sqraft/core";
import { selectionSiblingGaps, showSelectionSpacing } from "./selection-spacing";

function attach(doc: DocState, parentId: string, node: DocNode): DocNode {
  node.parentId = parentId;
  doc.nodes[node.id] = node;
  doc.nodes[parentId].children.push(node.id);
  return node;
}

function rect(x: number, y: number, width = 100, height = 100): DocNode {
  return createNode("rect", { x, y, width, height });
}

/** 只比较方向与数值，坐标顺序随实现走 */
function marks(doc: DocState, ids: string[], zoom = 1) {
  return selectionSiblingGaps(doc, ids, { zoom })
    .map((mark) => ({
      value: mark.value,
      axis: Math.abs(mark.x2 - mark.x1) >= Math.abs(mark.y2 - mark.y1) ? "h" : "v",
    }))
    .sort((a, b) => a.value - b.value);
}

describe("选中量距", () => {
  it("上下左右各取最近的一个兄弟", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const target = attach(doc, pageId, rect(100, 100));
    attach(doc, pageId, rect(0, 120, 60)); // 左，最近
    attach(doc, pageId, rect(0, 60, 60)); // 左，更远
    attach(doc, pageId, rect(260, 120)); // 右：60
    attach(doc, pageId, rect(120, 0, 100, 60)); // 上：40
    attach(doc, pageId, rect(120, 260)); // 下：60

    expect(marks(doc, [target.id])).toEqual([
      { value: 40, axis: "h" },
      { value: 40, axis: "v" },
      { value: 60, axis: "h" },
      { value: 60, axis: "v" },
    ]);
  });

  it("对角线上没有重叠的兄弟不算相邻", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const target = attach(doc, pageId, rect(100, 100));
    attach(doc, pageId, rect(260, 260)); // 右下角斜对
    expect(marks(doc, [target.id])).toEqual([]);
  });

  it("贴边与重叠都不画", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const target = attach(doc, pageId, rect(100, 100));
    attach(doc, pageId, rect(200, 100)); // 正好贴右边
    attach(doc, pageId, rect(150, 120)); // 与目标重叠
    expect(marks(doc, [target.id])).toEqual([]);
  });

  it("只算同父兄弟，跨层级不算", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const frame = attach(doc, pageId, createNode("frame", { x: 0, y: 0, width: 400, height: 400 }));
    const target = attach(doc, frame.id, rect(100, 100));
    attach(doc, pageId, rect(0, 100)); // 页面层，不是同父
    attach(doc, frame.id, rect(300, 100)); // 同父：100
    expect(marks(doc, [target.id])).toEqual([{ value: 100, axis: "h" }]);
  });

  it("隐藏的兄弟不参与", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const target = attach(doc, pageId, rect(100, 100));
    attach(doc, pageId, createNode("rect", { x: 0, y: 100, width: 80, height: 100, visible: false }));
    expect(marks(doc, [target.id])).toEqual([]);
  });

  it("缩放太小（端点不足 8px）时不画", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const target = attach(doc, pageId, rect(100, 100));
    attach(doc, pageId, rect(220, 100)); // 20px 间隙
    expect(marks(doc, [target.id], 1)).toEqual([{ value: 20, axis: "h" }]);
    expect(marks(doc, [target.id], 0.3)).toEqual([]);
  });

  it("多选用选区包围盒，且不把自己算成邻居", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const a = attach(doc, pageId, rect(100, 100));
    const b = attach(doc, pageId, rect(220, 100)); // 与 a 间距 20（选中后不算邻居）
    attach(doc, pageId, rect(0, 100, 60)); // 左：从选区左边界 100 算起 = 40
    attach(doc, pageId, rect(400, 100)); // 右：400 - (220 + 100) = 80

    expect(marks(doc, [a.id, b.id])).toEqual([
      { value: 40, axis: "h" },
      { value: 80, axis: "h" },
    ]);
  });

  it("多选跨父级时不算（跨层级比较没有意义）", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const frame = attach(doc, pageId, createNode("frame", { x: 0, y: 0, width: 400, height: 400 }));
    const inside = attach(doc, frame.id, rect(100, 100));
    const outside = attach(doc, pageId, rect(200, 100));
    expect(marks(doc, [inside.id, outside.id])).toEqual([]);
  });

  it("选区里有隐藏节点时整体不画（不用缩小后的包围盒）", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const visible = attach(doc, pageId, rect(100, 100));
    const hidden = attach(doc, pageId, createNode("rect", { x: 100, y: 100, width: 100, height: 100, visible: false }));
    attach(doc, pageId, rect(400, 100)); // 右：300（若把隐藏项算进来会变成 200）
    expect(marks(doc, [visible.id, hidden.id])).toEqual([]);
  });

  it("页面本身、空选区与不存在的节点返回空", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    attach(doc, pageId, rect(100, 100));
    expect(selectionSiblingGaps(doc, [], { zoom: 1 })).toEqual([]);
    expect(selectionSiblingGaps(doc, [pageId], { zoom: 1 })).toEqual([]);
    expect(selectionSiblingGaps(doc, ["missing"], { zoom: 1 })).toEqual([]);
  });
});

describe("量距显示门禁", () => {
  const base = { editing: true, tool: "select", busy: false, selectionCount: 1 };

  it("空闲的编辑态 + 选择工具 + 有选区 → 显示", () => {
    expect(showSelectionSpacing(base)).toBe(true);
  });

  it("有手势/编辑态（框选、拖参考线、钢笔、裁切、行内编辑）→ 不显示", () => {
    expect(showSelectionSpacing({ ...base, busy: true })).toBe(false);
  });

  it("非编辑模式、非选择工具或无选区 → 不显示", () => {
    expect(showSelectionSpacing({ ...base, editing: false })).toBe(false);
    expect(showSelectionSpacing({ ...base, tool: "rect" })).toBe(false);
    expect(showSelectionSpacing({ ...base, selectionCount: 0 })).toBe(false);
  });
});
