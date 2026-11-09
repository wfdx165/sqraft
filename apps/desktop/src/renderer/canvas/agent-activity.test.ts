import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, firstPageId, type DocState, type DocNode } from "@sqraft/core";
import type { Viewport } from "@sqraft/render";
import {
  AGENT_MAX_RECTS,
  agentFxActive,
  beginAgentActivity,
  isCrossPage,
  markRects,
  outermostNodes,
  pageOf,
  rectInViewport,
  resetAgentActivity,
  setAgentTargets,
} from "./agent-activity";

function doc(): { state: DocState; pageId: string } {
  const state = createDocWithPage();
  return { state, pageId: firstPageId(state)! };
}

function add(state: DocState, parentId: string, patch: Parameters<typeof createNode>[1] = {}): DocNode {
  const node = createNode("rect", { parentId, ...patch });
  state.nodes[node.id] = node;
  state.nodes[parentId].children.push(node.id);
  return node;
}

describe("改动节点收敛", () => {
  it("建一棵子树只留最外层", () => {
    const { state, pageId } = doc();
    const frame = add(state, pageId);
    const child = add(state, frame.id);
    const grandchild = add(state, child.id);

    expect(outermostNodes([frame.id, child.id, grandchild.id], state.nodes)).toEqual([frame.id]);
  });

  it("兄弟节点各自保留（互不包含）", () => {
    const { state, pageId } = doc();
    const a = add(state, pageId);
    const b = add(state, pageId);

    expect(outermostNodes([a.id, b.id], state.nodes).sort()).toEqual([a.id, b.id].sort());
  });

  it("页面本身也在改动集合里时，页面与它下面的子树各自保留（页面不吞掉子节点）", () => {
    const { state, pageId } = doc();
    const frame = add(state, pageId);
    const child = add(state, frame.id);

    expect(outermostNodes([pageId, frame.id, child.id], state.nodes).sort()).toEqual([pageId, frame.id].sort());
  });

  it("页面本身不参与描边（整页虚线没有信息量）", () => {
    const { state, pageId } = doc();
    expect(markRects([pageId], state)).toEqual([]);
  });

  it("已经不在文档里的 id（删除）直接跳过", () => {
    const { state, pageId } = doc();
    const frame = add(state, pageId);
    const child = add(state, frame.id);
    delete state.nodes[child.id];

    expect(outermostNodes([frame.id, child.id], state.nodes)).toEqual([frame.id]);
  });
});

describe("节点归属页面", () => {
  it("深层节点追到祖先页", () => {
    const { state, pageId } = doc();
    const frame = add(state, pageId);
    const child = add(state, frame.id);

    expect(pageOf(state.nodes, child.id)).toBe(pageId);
  });

  it("页面返回自己", () => {
    const { state, pageId } = doc();
    expect(pageOf(state.nodes, pageId)).toBe(pageId);
  });

  it("根级主组件不属于任何页面", () => {
    const { state } = doc();
    const component = createNode("component", { x: 0, y: 0, width: 100, height: 100 });
    state.rootIds.push(component.id);
    state.nodes[component.id] = component;

    expect(pageOf(state.nodes, component.id)).toBeNull();
  });
});

describe("描边矩形", () => {
  it("用世界坐标（嵌套节点要累加父级偏移）", () => {
    const { state, pageId } = doc();
    const frame = add(state, pageId, { x: 100, y: 50, width: 200, height: 200 });
    const child = add(state, frame.id, { x: 10, y: 20, width: 30, height: 40 });

    expect(markRects([child.id], state)).toEqual([{ x: 110, y: 70, width: 30, height: 40 }]);
  });

  it("数量超过上限时退化成整体包围盒", () => {
    const { state, pageId } = doc();
    const ids: string[] = [];
    for (let i = 0; i < AGENT_MAX_RECTS + 1; i += 1) {
      ids.push(add(state, pageId, { x: i * 10, y: 0, width: 10, height: 10 }).id);
    }

    const rects = markRects(ids, state);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ x: 0, y: 0, width: AGENT_MAX_RECTS * 10 + 10, height: 10 });
  });
});

describe("视口相交", () => {
  const view = { x: 0, y: 0, width: 100, height: 100 };

  it("贴边不算可见", () => {
    expect(rectInViewport({ x: 100, y: 0, width: 10, height: 10 }, view)).toBe(false);
    expect(rectInViewport({ x: 99, y: 0, width: 10, height: 10 }, view)).toBe(true);
  });

  it("完全在视口外", () => {
    expect(rectInViewport({ x: -50, y: -50, width: 10, height: 10 }, view)).toBe(false);
    expect(rectInViewport({ x: 20, y: 20, width: 10, height: 10 }, view)).toBe(true);
  });
});

describe("跨页判定", () => {
  it("编辑模式：活动页之外算跨页", () => {
    expect(isCrossPage("p2", "p1", true)).toBe(true);
    expect(isCrossPage("p1", "p1", true)).toBe(false);
  });

  it("拖动模式没有当前页概念，一律不算跨页", () => {
    expect(isCrossPage("p2", "p1", false)).toBe(false);
  });

  it("不属于任何页面（根级主组件 / 只改 Token）不算跨页", () => {
    expect(isCrossPage(null, "p1", true)).toBe(false);
  });
});

describe("呼吸续帧", () => {
  const vp: Viewport = { x: 0, y: 0, zoom: 1, width: 100, height: 100, dpr: 1 };

  it("改动在视口外就不为它重绘", () => {
    beginAgentActivity();
    setAgentTargets([{ x: 1000, y: 1000, width: 10, height: 10 }], null);
    expect(agentFxActive(performance.now(), vp)).toBe(false);

    setAgentTargets([{ x: 10, y: 10, width: 10, height: 10 }], null);
    expect(agentFxActive(performance.now(), vp)).toBe(true);
    resetAgentActivity();
  });
});
