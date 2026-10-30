import { describe, expect, it } from "vitest";
import { createNode, type DocNode, type NodeId } from "@sqraft/core";
import { canExpand, isLayerExpanded } from "./layer-tree";

function node(type: DocNode["type"], extra: Partial<DocNode> = {}): DocNode {
  return { ...createNode(type, {}), ...extra };
}

/** 造一个"有子元素"的节点：children 里放一个占位 id 即可，判定只看长度。 */
function withChild(base: DocNode, childId = "child"): DocNode {
  return { ...base, children: [childId as NodeId] };
}

describe("图层树展开态", () => {
  it("实例默认折叠", () => {
    expect(isLayerExpanded(node("instance"), {})).toBe(false);
  });

  it("实例记录为展开后显示内部图层", () => {
    const instance = node("instance");
    expect(isLayerExpanded(instance, { [instance.id]: true })).toBe(true);
  });

  it("画板 / 分组 / 组件 / 插槽默认展开", () => {
    for (const type of ["frame", "group", "component", "slot"] as const) {
      expect(isLayerExpanded(node(type), {})).toBe(true);
    }
  });

  it("默认展开的类型记录成折叠后收起", () => {
    const frame = node("frame");
    expect(isLayerExpanded(frame, { [frame.id]: false })).toBe(false);
  });
});

describe("可折叠判定", () => {
  it("有子元素且未锁定 → 可折叠", () => {
    expect(canExpand(withChild(node("frame")))).toBe(true);
  });

  it("叶子节点不可折叠", () => {
    expect(canExpand(node("rect"))).toBe(false);
  });

  it("锁定的容器不可折叠（子树本来就不显示）", () => {
    expect(canExpand(withChild(node("group", { locked: true })))).toBe(false);
  });
});
