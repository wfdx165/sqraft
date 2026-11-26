import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, DocStore, firstPageId } from "@sqraft/core";
import type { Viewport } from "@sqraft/render";
import { pathAnchorAt, type PenState } from "./pen";

const VIEWPORT: Viewport = { x: 0, y: 0, width: 400, height: 300, zoom: 1, dpr: 1 };

function setup() {
  const store = new DocStore(createDocWithPage());
  const pageId = firstPageId(store.doc)!;
  const path = createNode("path", {
    x: 0,
    y: 0,
    vector: {
      contours: [
        {
          closed: true,
          anchors: [
            { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
            { x: 100, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
            { x: 100, y: 100, inX: 0, inY: 0, outX: 0, outY: 0 },
          ],
        },
        {
          closed: true,
          anchors: [
            { x: 40, y: 40, inX: 0, inY: 0, outX: 20, outY: 0 },
            { x: 60, y: 40, inX: 0, inY: 0, outX: 0, outY: 0 },
            { x: 60, y: 60, inX: 0, inY: 0, outX: 0, outY: 0 },
          ],
        },
      ],
      fillRule: "evenodd",
    },
  });
  store.apply({ type: "node.create", params: { nodes: [path], parentId: pageId } });
  const pen: PenState = { draft: null, penHover: null, pathEdit: { id: path.id, contour: 0, active: 0 }, vectorDrag: null };
  return { store, pen };
}

describe("锚点命中：多轮廓", () => {
  it("第二条轮廓的锚点也能选中，并带上轮廓下标", () => {
    const { store, pen } = setup();
    const deps = { docStore: store };
    expect(pathAnchorAt(pen, deps, VIEWPORT, 0, 0)).toMatchObject({ contour: 0, index: 0 });
    expect(pathAnchorAt(pen, deps, VIEWPORT, 100, 100)).toMatchObject({ contour: 0, index: 2 });
    expect(pathAnchorAt(pen, deps, VIEWPORT, 60, 60)).toMatchObject({ contour: 1, index: 2 });
  });

  it("手柄优先于同位置的锚点，并返回 side", () => {
    const { store, pen } = setup();
    const deps = { docStore: store };
    pen.pathEdit = { id: pen.pathEdit!.id, contour: 1, active: 0 };
    // 第二条轮廓第一个锚点的出手柄正好落在下一个锚点 (60,40) 上
    expect(pathAnchorAt(pen, deps, VIEWPORT, 60, 40)).toMatchObject({ contour: 1, index: 0, side: "out" });
  });
});
