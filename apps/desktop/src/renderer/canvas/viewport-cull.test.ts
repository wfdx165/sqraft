import { describe, expect, it } from "vitest";
import { createNode, DocStore, createEmptyDoc, subtreeWorldBounds, type DocNode, type NodeId, type Rect } from "@sqraft/core";
import { createRootBoundsCache, drawDocument, rootDrawBounds, type DrawOptions, type RenderBackend } from "@sqraft/render";

/** 只记录调用的后端：画了哪些节点、开了哪些不透明度层。 */
function recorder(): { backend: RenderBackend; drawn: Set<NodeId>; opacity: Array<{ alpha: number; bounds?: Rect }> } {
  const drawn = new Set<NodeId>();
  const opacity: Array<{ alpha: number; bounds?: Rect }> = [];
  const record = (node: DocNode) => drawn.add(node.id);
  const noop = () => {};
  const backend: RenderBackend = {
    beginFrame: noop,
    pushTransform: noop,
    popTransform: noop,
    pushClip: noop,
    popClip: noop,
    pushOpacity: (alpha, bounds) => opacity.push({ alpha, bounds }),
    popOpacity: noop,
    pushEffects: noop,
    popEffects: noop,
    drawRect: record,
    drawEllipse: record,
    drawLine: record,
    drawPath: record,
    drawPolygon: record,
    drawText: record,
    drawImage: record,
    drawImagePlaceholder: record,
    drawImageInRect: noop,
    pushMaskLayer: noop,
    popMaskLayer: noop,
    endFrame: noop,
  };
  return { backend, drawn, opacity };
}

/** 三个横排页面（各 400×300，间隔 1000）+ 每页一个子矩形 + 远处一个主组件。 */
function setup() {
  const store = new DocStore(createEmptyDoc());
  const pages: NodeId[] = [];
  const rects: NodeId[] = [];
  for (let i = 0; i < 3; i++) {
    const page = createNode("page", { name: `P${i}`, x: i * 1000, y: 0, width: 400, height: 300 });
    const rect = createNode("rect", { name: `R${i}`, x: 10, y: 10, width: 50, height: 50 });
    store.apply({ type: "node.create", params: { nodes: [page], parentId: null } });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: page.id } });
    pages.push(page.id);
    rects.push(rect.id);
  }
  const master = createNode("component", { name: "M", x: 0, y: 5000, width: 100, height: 40 });
  store.apply({ type: "node.create", params: { nodes: [master], parentId: null } });
  return { store, pages, rects, masterId: master.id };
}

function cullFor(store: DocStore, rect: Rect): NonNullable<DrawOptions["cull"]> {
  const cache = createRootBoundsCache();
  return { rect, rootBounds: (id) => cache(store.doc, id), pad: 0 };
}

describe("视口剔除（ADR-0032）", () => {
  it("视口外的页面与主组件整棵跳过，视口内照常绘制", () => {
    const { store, pages, rects, masterId } = setup();
    const { backend, drawn } = recorder();
    drawDocument(backend, store.doc, { cull: cullFor(store, { x: 900, y: -100, width: 600, height: 500 }) });
    expect(drawn.has(pages[1])).toBe(true);
    expect(drawn.has(rects[1])).toBe(true);
    for (const id of [pages[0], rects[0], pages[2], rects[2], masterId]) expect(drawn.has(id)).toBe(false);
  });

  it("不传 cull 时全部绘制（导出等离屏渲染）", () => {
    const { store, pages, masterId } = setup();
    const { backend, drawn } = recorder();
    drawDocument(backend, store.doc);
    for (const id of [...pages, masterId]) expect(drawn.has(id)).toBe(true);
  });

  it("淡化页面：视口外的不开层，视口内的层按该页包围盒开", () => {
    const { store, pages } = setup();
    const { backend, opacity } = recorder();
    drawDocument(backend, store.doc, {
      dimPageIds: [pages[0], pages[1]],
      cull: cullFor(store, { x: 900, y: -100, width: 600, height: 500 }),
    });
    expect(opacity).toHaveLength(1);
    expect(opacity[0]).toEqual({ alpha: 0.35, bounds: { x: 1000, y: 0, width: 400, height: 300 } });
  });

  it("拖动预览中的根不剔除：预览几何不在缓存的包围盒里", () => {
    const { store, pages, rects } = setup();
    const { backend, drawn } = recorder();
    drawDocument(backend, store.doc, {
      movePreview: { ids: [rects[2]], dx: -2000, dy: 0 },
      cull: cullFor(store, { x: 0, y: 0, width: 400, height: 300 }),
    });
    expect(drawn.has(rects[2])).toBe(true);
    expect(drawn.has(pages[1])).toBe(false);
  });

  it("包围盒是保守的：覆盖旋转嵌套子树的真实包围盒，并计入描边与效果外扩", () => {
    const store = new DocStore(createEmptyDoc());
    const page = createNode("page", { name: "P", x: 100, y: 100, width: 200, height: 200 });
    const frame = createNode("frame", { name: "F", x: 150, y: 150, width: 100, height: 60, rotation: 30 });
    const child = createNode("rect", {
      name: "C",
      x: 80,
      y: 40,
      width: 60,
      height: 30,
      rotation: -45,
      style: {
        strokeWidth: 4,
        effects: [{ type: "drop-shadow", visible: true, x: 0, y: 6, blur: 10, spread: 0, color: { value: "#000" } }],
      },
    });
    store.apply({ type: "node.create", params: { nodes: [page], parentId: null } });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: page.id } });
    store.apply({ type: "node.create", params: { nodes: [child], parentId: frame.id } });

    const fast = rootDrawBounds(store.doc, page.id)!;
    const exact = subtreeWorldBounds(store.doc, page.id)!;
    expect(fast.x).toBeLessThanOrEqual(exact.x);
    expect(fast.y).toBeLessThanOrEqual(exact.y);
    expect(fast.x + fast.width).toBeGreaterThanOrEqual(exact.x + exact.width + 4 - 1e-6);
    expect(fast.y + fast.height).toBeGreaterThanOrEqual(exact.y + exact.height + 4 - 1e-6);
  });

  it("缓存随文档版本失效：改动后包围盒跟着变", () => {
    const { store, pages, rects } = setup();
    const cache = createRootBoundsCache();
    const before = cache(store.doc, pages[0])!;
    expect(cache(store.doc, pages[0])).toBe(before);
    store.apply({ type: "node.update", params: { nodeId: rects[0], patch: { x: 900 } } });
    const after = cache(store.doc, pages[0])!;
    expect(after.x + after.width).toBeGreaterThanOrEqual(950);
    expect(before.x + before.width).toBeLessThan(950);
  });
});
