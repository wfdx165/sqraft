import { describe, expect, it } from "vitest";
import { createEmptyDoc, createNode, DocStore, type DocNode } from "@sqraft/core";
import { drawDocument, type DrawOptions, type RenderBackend } from "@sqraft/render";

const SHADOW = [{ type: "drop-shadow" as const, visible: true, x: 0, y: 2, blur: 6, spread: 0, color: { value: "#000" } }];

/** 记录 pushEffects 收到的 key 与画了哪些节点；`hitKeys` 里的 key 视为缓存命中。 */
function recorder(hitKeys: Set<string> = new Set()) {
  const keys: Array<string | undefined> = [];
  const drawn = new Set<string>();
  const noop = () => {};
  const backend = new Proxy({} as RenderBackend, {
    get: (_t, prop) => {
      if (prop === "pushEffects") return (_n: DocNode, _e: unknown, key?: string) => (keys.push(key), key !== undefined && hitKeys.has(key));
      if (prop === "pushMaskLayer") return (_b: unknown, key?: string) => (keys.push(key), key !== undefined && hitKeys.has(key));
      if (typeof prop === "string" && prop.startsWith("draw")) return (node: DocNode) => drawn.add(node.id);
      return noop;
    },
  });
  return { backend, keys, drawn };
}

function setup() {
  const store = new DocStore(createEmptyDoc());
  const page = createNode("page", { name: "P", x: 0, y: 0, width: 500, height: 500 });
  const card = createNode("group", { name: "card", x: 10, y: 10, width: 100, height: 60, style: { effects: SHADOW } });
  const bg = createNode("rect", { name: "bg", x: 0, y: 0, width: 100, height: 60, style: { fill: { value: "#fff" } } });
  store.apply({ type: "node.create", params: { nodes: [page], parentId: null } });
  store.apply({ type: "node.create", params: { nodes: [card], parentId: page.id } });
  store.apply({ type: "node.create", params: { nodes: [bg], parentId: card.id } });
  return { store, card, bg };
}

describe("效果层跨帧缓存（ADR-0033）", () => {
  it("给了 epoch 才带 key；命中时整棵子树不再绘制", () => {
    const { store, card, bg } = setup();
    const miss = recorder();
    drawDocument(miss.backend, store.doc, { effectCacheEpoch: "e1" });
    expect(miss.keys).toEqual([`${card.id}@e1`]);
    expect(miss.drawn.has(bg.id)).toBe(true);

    const hit = recorder(new Set([`${card.id}@e1`]));
    drawDocument(hit.backend, store.doc, { effectCacheEpoch: "e1" });
    expect(hit.drawn.has(bg.id)).toBe(false);
  });

  it("不给 epoch（导出）时不带 key，照常逐帧合成", () => {
    const { store } = setup();
    const r = recorder();
    drawDocument(r.backend, store.doc);
    expect(r.keys).toEqual([undefined]);
  });

  it("子节点在拖动预览中：祖先的效果层不用缓存（预览几何不在缓存里）", () => {
    const { store, card, bg } = setup();
    const options: DrawOptions = { effectCacheEpoch: "e1", movePreview: { ids: [bg.id], dx: 5, dy: 0 } };
    const r = recorder(new Set([`${card.id}@e1`]));
    drawDocument(r.backend, store.doc, options);
    expect(r.keys).toEqual([undefined]);
    expect(r.drawn.has(bg.id)).toBe(true);
  });

  it("行内编辑中的文本同样让祖先失去缓存", () => {
    const { store, card } = setup();
    const label = createNode("text", { name: "t", x: 0, y: 0, width: 50, height: 20, text: "hi", style: { fill: { value: "#000" } } });
    store.apply({ type: "node.create", params: { nodes: [label], parentId: card.id } });
    const r = recorder();
    drawDocument(r.backend, store.doc, { effectCacheEpoch: "e1", hideTextId: label.id });
    expect(r.keys).toEqual([undefined]);
  });

  it("蒙版层同样带 key；命中时被遮的子树与蒙版形状都不再绘制", () => {
    const store = new DocStore(createEmptyDoc());
    const page = createNode("page", { name: "P", x: 0, y: 0, width: 500, height: 500 });
    const mask = createNode("ellipse", { name: "m", x: 0, y: 0, width: 50, height: 50, isMask: true, style: { fill: { value: "#000" } } });
    const photo = createNode("rect", { name: "photo", x: 0, y: 0, width: 80, height: 80, style: { fill: { value: "#0af" } } });
    store.apply({ type: "node.create", params: { nodes: [page], parentId: null } });
    store.apply({ type: "node.create", params: { nodes: [mask], parentId: page.id } });
    store.apply({ type: "node.create", params: { nodes: [photo], parentId: page.id } });
    const key = `${mask.id}>${photo.id}@e1`;
    const miss = recorder();
    drawDocument(miss.backend, store.doc, { effectCacheEpoch: "e1" });
    expect(miss.keys).toEqual([key]);
    expect(miss.drawn.has(photo.id)).toBe(true);
    const hit = recorder(new Set([key]));
    drawDocument(hit.backend, store.doc, { effectCacheEpoch: "e1" });
    expect(hit.drawn.has(photo.id)).toBe(false);
    expect(hit.drawn.has(mask.id)).toBe(false);
  });
});
