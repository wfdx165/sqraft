import { describe, expect, it } from "vitest";
import { createEmptyDoc, createNode, firstPageId, type DocState } from "@sqraft/core";
import { intersects, marqueeHits } from "./marquee";

function doc(): { state: DocState; pageId: string } {
  const state = createEmptyDoc();
  return { state, pageId: firstPageId(state)! };
}

function add(state: DocState, parentId: string, patch: Parameters<typeof createNode>[1]) {
  const node = createNode("rect", { parentId, ...patch });
  state.nodes[node.id] = node;
  const parent = state.nodes[parentId];
  parent.children.push(node.id);
  return node;
}

describe("框选命中", () => {
  it("包围盒相交即选（贴边不算）", () => {
    expect(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });

  it("只选当前层级的直接子节点，不穿透容器", () => {
    const { state, pageId } = doc();
    const frame = createNode("frame", { parentId: pageId, x: 0, y: 0, width: 100, height: 100 });
    state.nodes[frame.id] = frame;
    state.nodes[pageId].children.push(frame.id);
    const child = add(state, frame.id, { x: 10, y: 10, width: 10, height: 10 });

    const hits = marqueeHits(state, pageId, { x: 5, y: 5, width: 50, height: 50 });
    expect(hits).toEqual([frame.id]);
    expect(hits).not.toContain(child.id);
  });

  it("跳过隐藏与锁定（含祖先锁定）的节点", () => {
    const { state, pageId } = doc();
    const hidden = add(state, pageId, { x: 0, y: 0, width: 10, height: 10, visible: false });
    const locked = add(state, pageId, { x: 20, y: 0, width: 10, height: 10, locked: true });
    const normal = add(state, pageId, { x: 40, y: 0, width: 10, height: 10 });

    const hits = marqueeHits(state, pageId, { x: -10, y: -10, width: 100, height: 100 });
    expect(hits).toEqual([normal.id]);
    expect(hits).not.toContain(hidden.id);
    expect(hits).not.toContain(locked.id);
  });

  it("层级不存在时返回空", () => {
    const { state } = doc();
    expect(marqueeHits(state, null, { x: 0, y: 0, width: 10, height: 10 })).toEqual([]);
  });
});
