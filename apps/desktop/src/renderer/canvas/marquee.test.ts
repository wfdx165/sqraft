import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, firstPageId, type DocState } from "@sqraft/core";
import { intersects, marqueeHits, marqueePageHits, resolveMarqueeSelection } from "./marquee";

function doc(): { state: DocState; pageId: string } {
  const state = createDocWithPage();
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

  it("跨画板框选命中多个可见未锁定画板，跳过隐藏分组与锁定分组里的画板", () => {
    const { state, pageId: p1 } = doc();
    const p2 = createNode("page", { name: "P2", x: 1600, y: 0, width: 1440, height: 1024 });
    const p3 = createNode("page", { name: "P3", x: 3200, y: 0, width: 1440, height: 1024, groupId: "g_hidden" });
    const p4 = createNode("page", { name: "P4", x: 4800, y: 0, width: 1440, height: 1024, groupId: "g_locked" });
    state.pageGroups = [
      { id: "g_hidden", name: "隐藏组", visible: false },
      { id: "g_locked", name: "锁定组", locked: true },
    ];
    for (const p of [p2, p3, p4]) {
      state.nodes[p.id] = p;
      state.rootIds.push(p.id);
    }

    const rect = { x: -50, y: -50, width: 7000, height: 1200 };
    expect(marqueePageHits(state, rect)).toEqual([p1, p2.id]);
    expect(
      resolveMarqueeSelection(state, p1, [], rect, { additive: false, base: [] }),
    ).toEqual([p1, p2.id]);
  });

  it("仅框选活动画板内部时优先命中图层；未命中图层但框中画板时选中画板", () => {
    const { state, pageId: p1 } = doc();
    const box = add(state, p1, { x: 20, y: 20, width: 80, height: 80 });

    // 命中活动页内图层
    expect(
      resolveMarqueeSelection(state, p1, [], { x: -10, y: -10, width: 60, height: 60 }, { additive: false, base: [] }),
    ).toEqual([box.id]);

    // 未命中图层但与活动页相交
    expect(
      resolveMarqueeSelection(state, p1, [], { x: 400, y: 400, width: 50, height: 50 }, { additive: false, base: [] }),
    ).toEqual([p1]);
  });
});
