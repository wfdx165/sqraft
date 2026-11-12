import { describe, expect, it } from "vitest";
import { createEmptyDoc, createNode, DocStore, type DocNode } from "@sqraft/core";
import { createRootBoundsCache, drawDocument, type DrawOptions, type RenderBackend } from "@sqraft/render";

type Mode = "hit" | "drawing" | "uncached";

function recorder(mode: Mode) {
  const rootKeys: string[] = [];
  const opacity: number[] = [];
  const drawn = new Set<string>();
  let pops = 0;
  let incomplete = 0;
  const noop = () => {};
  const backend = new Proxy({} as RenderBackend, {
    get: (_t, prop) => {
      if (prop === "pushRootCache") return (_b: unknown, key: string) => (rootKeys.push(key), mode);
      if (prop === "popRootCache") return () => pops++;
      if (prop === "noteIncomplete") return () => incomplete++;
      if (prop === "pushOpacity") return (alpha: number) => opacity.push(alpha);
      if (typeof prop === "string" && prop.startsWith("draw")) return (node: DocNode) => drawn.add(node.id);
      return noop;
    },
  });
  return { backend, rootKeys, opacity, drawn, pops: () => pops, incomplete: () => incomplete };
}

function setup() {
  const store = new DocStore(createEmptyDoc());
  const page = createNode("page", { name: "P", x: 0, y: 0, width: 400, height: 300 });
  const rect = createNode("rect", { name: "r", x: 10, y: 10, width: 50, height: 50, style: { fill: { value: "#f00" } } });
  store.apply({ type: "node.create", params: { nodes: [page], parentId: null } });
  store.apply({ type: "node.create", params: { nodes: [rect], parentId: page.id } });
  const bounds = createRootBoundsCache();
  const cull: NonNullable<DrawOptions["cull"]> = { rect: { x: -100, y: -100, width: 1000, height: 1000 }, rootBounds: (id) => bounds(store.doc, id), pad: 0 };
  return { store, page, rect, cull };
}

describe("整页缓存（ADR-0033）", () => {
  it("命中时整页（底色、子树）都不画；淡化页面不再单开不透明度层", () => {
    const { store, page, rect, cull } = setup();
    const r = recorder("hit");
    drawDocument(r.backend, store.doc, { cull, effectCacheEpoch: "e1", dimPageIds: [page.id] });
    expect(r.rootKeys).toEqual([`root:${page.id}@e1`]);
    expect(r.drawn.size).toBe(0);
    expect(r.opacity).toEqual([]);
    expect(r.pops()).toBe(1);
    void rect;
  });

  it("未命中时照常画整页并写缓存，淡化由缓存层负责", () => {
    const { store, page, rect, cull } = setup();
    const r = recorder("drawing");
    drawDocument(r.backend, store.doc, { cull, effectCacheEpoch: "e1", dimPageIds: [page.id] });
    expect(r.drawn.has(page.id)).toBe(true);
    expect(r.drawn.has(rect.id)).toBe(true);
    expect(r.opacity).toEqual([]);
    expect(r.pops()).toBe(1);
  });

  it("太大不缓存时按原路径：淡化照旧开层，不调用 popRootCache", () => {
    const { store, page, cull } = setup();
    const r = recorder("uncached");
    drawDocument(r.backend, store.doc, { cull, effectCacheEpoch: "e1", dimPageIds: [page.id] });
    expect(r.opacity).toEqual([0.35]);
    expect(r.pops()).toBe(0);
  });

  it("页面里有节点在拖动预览 / 没有剔除（导出）/ 没有 epoch：都不走整页缓存", () => {
    const { store, rect, cull } = setup();
    const a = recorder("hit");
    drawDocument(a.backend, store.doc, { cull, effectCacheEpoch: "e1", movePreview: { ids: [rect.id], dx: 3, dy: 0 } });
    const b = recorder("hit");
    drawDocument(b.backend, store.doc, { effectCacheEpoch: "e1" });
    const c = recorder("hit");
    drawDocument(c.backend, store.doc, { cull });
    expect([a.rootKeys, b.rootKeys, c.rootKeys]).toEqual([[], [], []]);
    expect(a.drawn.has(rect.id)).toBe(true);
  });
});

describe("极小元素跳过", () => {
  it("屏幕上不到半个设备像素的叶子不画；导出（不给 pixelRatio）照常画", () => {
    const { store, rect } = setup();
    // 50 文档单位 × 0.005 = 0.25 设备像素
    const tiny = recorder("uncached");
    drawDocument(tiny.backend, store.doc, { pixelRatio: 0.005 });
    expect(tiny.drawn.has(rect.id)).toBe(false);
    const visible = recorder("uncached");
    drawDocument(visible.backend, store.doc, { pixelRatio: 0.02 });
    expect(visible.drawn.has(rect.id)).toBe(true);
    const exported = recorder("uncached");
    drawDocument(exported.backend, store.doc);
    expect(exported.drawn.has(rect.id)).toBe(true);
  });
});

describe("图片未就绪时缓存记为未完成", () => {
  it("嵌入图还在解码：通知后端；已就绪的不通知", () => {
    const store = new DocStore(createEmptyDoc());
    const page = createNode("page", { name: "P", x: 0, y: 0, width: 400, height: 300 });
    const image = createNode("image", {
      name: "img", x: 0, y: 0, width: 100, height: 100,
      image: { assetId: "a1", naturalWidth: 1000, naturalHeight: 1000 },
    });
    store.apply({ type: "node.create", params: { nodes: [page], parentId: null } });
    store.apply({ type: "node.create", params: { nodes: [image], parentId: page.id } });
    const pending = recorder("drawing");
    drawDocument(pending.backend, store.doc, { imagePending: () => true });
    expect(pending.incomplete()).toBe(1);
    const ready = recorder("drawing");
    drawDocument(ready.backend, store.doc, { imagePending: () => false });
    expect(ready.incomplete()).toBe(0);
  });
});
