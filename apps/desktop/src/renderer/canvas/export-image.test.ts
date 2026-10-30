import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, type DocState } from "@sqraft/core";
import { exportBounds } from "./export-image";

function setup() {
  const doc: DocState = createDocWithPage();
  const pageId = doc.rootIds[0];
  const add = (x: number, y: number, w: number, h: number) => {
    const node = createNode("rect", { parentId: pageId, x, y, width: w, height: h });
    doc.nodes[node.id] = node;
    doc.nodes[pageId].children.push(node.id);
    return node;
  };
  return { doc, pageId, add };
}

describe("PNG 导出区域", () => {
  it("无选区时取整页", () => {
    const { doc, pageId } = setup();
    expect(exportBounds(doc, { pageId })).toMatchObject({ x: 0, y: 0 });
  });

  it("有选区时取并集", () => {
    const { doc, pageId, add } = setup();
    const a = add(10, 20, 30, 40);
    const b = add(100, 80, 20, 20);
    expect(exportBounds(doc, { pageId, nodeIds: [a.id, b.id] })).toEqual({
      x: 10,
      y: 20,
      width: 110,
      height: 80,
    });
  });

  it("只给 nodeIds（无页面）也能取包围盒：纯组件稿导出母版", () => {
    const { doc } = setup();
    const master = createNode("component", { name: "母版", x: 900, y: 1100, width: 120, height: 80 });
    doc.nodes[master.id] = master;
    doc.rootIds.push(master.id);
    expect(exportBounds(doc, { nodeIds: [master.id] })).toEqual({ x: 900, y: 1100, width: 120, height: 80 });
  });

  it("节点不存在时退回 null", () => {
    const { doc, pageId } = setup();
    expect(exportBounds(doc, { pageId, nodeIds: ["missing"] })).toBeNull();
  });
});

describe("PNG 导出区域：旋转 / 效果 / 子树", () => {
  /** 把节点直接挂进页面（测试不需要走命令栈）。 */
  function attach(doc: DocState, pageId: string, node: ReturnType<typeof createNode>) {
    node.parentId = pageId;
    doc.nodes[node.id] = node;
    doc.nodes[pageId].children.push(node.id);
    return node;
  }

  it("旋转 45° 的方形按旋转后的外接框取景", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const rect = attach(doc, pageId, createNode("rect", { x: 100, y: 60, width: 100, height: 100, rotation: 45 }));
    const bounds = exportBounds(doc, { pageId, nodeIds: [rect.id] });
    const diagonal = 100 * Math.SQRT2;
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeCloseTo(diagonal, 5);
    expect(bounds!.height).toBeCloseTo(diagonal, 5);
    // 中心不变
    expect(bounds!.x + bounds!.width / 2).toBeCloseTo(150, 5);
    expect(bounds!.y + bounds!.height / 2).toBeCloseTo(110, 5);
  });

  it("drop-shadow 的外扩被算进取景", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const rect = attach(
      doc,
      pageId,
      createNode("rect", {
        x: 10,
        y: 10,
        width: 40,
        height: 40,
        style: {
          effects: [
            {
              type: "drop-shadow",
              visible: true,
              x: 0,
              y: 8,
              blur: 10,
              spread: 2,
              color: { value: "#00000033" },
            },
          ],
        },
      }),
    );
    // pad = blur*3 + dist + |spread| = 30 + 8 + 2 = 40
    const pad = 10 * 3 + 8 + 2;
    expect(exportBounds(doc, { pageId, nodeIds: [rect.id] })).toEqual({
      x: 10 - pad,
      y: 10 - pad,
      width: 40 + pad * 2,
      height: 40 + pad * 2,
    });
  });

  it("画板外的子节点也进选区取景", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    const frame = attach(doc, pageId, createNode("frame", { x: 0, y: 0, width: 100, height: 100 }));
    attach(doc, frame.id, createNode("rect", { x: 80, y: 20, width: 60, height: 40 }));
    const bounds = exportBounds(doc, { pageId, nodeIds: [frame.id] });
    expect(bounds).toMatchObject({ x: 0, y: 0 });
    expect(bounds!.width).toBeCloseTo(140, 5);
    expect(bounds!.height).toBeCloseTo(100, 5);
  });

  it("页面导出仍取页面矩形，不因溢出子节点变大", () => {
    const doc = createDocWithPage();
    const pageId = doc.rootIds[0];
    attach(doc, pageId, createNode("rect", { x: 1400, y: 0, width: 200, height: 100 }));
    const bounds = exportBounds(doc, { pageId });
    expect(bounds).toEqual({ x: 0, y: 0, width: 1440, height: 1024 });
  });
});
