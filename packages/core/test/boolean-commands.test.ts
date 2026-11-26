import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, firstPageId } from "../src/model";
import { DocStore } from "../src/store";
import { pointInVector, type VectorPath } from "../src/vector";

function setup() {
  const store = new DocStore(createDocWithPage());
  const pageId = firstPageId(store.doc)!;
  const add = (patch: Partial<Parameters<typeof createNode>[1]> = {}) => {
    const node = createNode("rect", patch);
    store.apply({ type: "node.create", params: { nodes: [node], parentId: pageId } });
    return node.id;
  };
  return { store, pageId, add };
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("布尔命令", () => {
  it("并集：结果烘焙成 path，取最上层样式与名字，一次撤销全回来", () => {
    const { store, pageId, add } = setup();
    const a = add({ name: "A", x: 0, y: 0, width: 100, height: 100, style: { fill: { value: "#ff0000" } } });
    const b = add({ name: "B", x: 50, y: 0, width: 100, height: 100, style: { fill: { value: "#0000ff" } } });
    store.apply({ type: "boolean.union", params: { nodeIds: [a, b], resultId: "n_result" } });

    const result = store.doc.nodes["n_result"];
    expect(result.type).toBe("path");
    expect(result.name).toBe("B");
    expect(result.style.fill).toEqual({ value: "#0000ff" });
    expect(result.vector?.fillRule).toBe("evenodd");
    expect(result.parentId).toBe(pageId);
    expect(store.doc.nodes[a]).toBeUndefined();
    expect(store.doc.nodes[b]).toBeUndefined();
    expect(store.doc.nodes[pageId].children).toEqual(["n_result"]);
    expect(pointInVector(result.vector as VectorPath, 75, 50)).toBe(true);

    store.undo();
    expect(store.doc.nodes["n_result"]).toBeUndefined();
    expect(store.doc.nodes[a]?.type).toBe("rect");
    expect(store.doc.nodes[b]?.type).toBe("rect");
  });

  it("差集：被减数永远是最底层，样式与名字取它", () => {
    const { store, add } = setup();
    const bottom = add({ name: "Bottom", x: 0, y: 0, width: 100, height: 100, style: { fill: { value: "#111111" } } });
    const top = add({ name: "Top", x: 25, y: 25, width: 50, height: 50, style: { fill: { value: "#222222" } } });
    store.apply({ type: "boolean.subtract", params: { nodeIds: [top, bottom], resultId: "n_hole" } });

    const result = store.doc.nodes["n_hole"];
    expect(result.name).toBe("Bottom");
    expect(result.style.fill).toEqual({ value: "#111111" });
    expect(result.vector?.contours).toHaveLength(2);
    const filled = result.vector as VectorPath;
    expect(pointInVector(filled, 50, 50)).toBe(false);
    expect(pointInVector(filled, 10, 10)).toBe(true);
  });

  it("intersect 无重叠时抛 core.boolean.noOverlap", () => {
    const { store, add } = setup();
    const a = add({ x: 0, y: 0, width: 20, height: 20 });
    const b = add({ x: 100, y: 100, width: 20, height: 20 });
    expect(codeOf(() => store.apply({ type: "boolean.intersect", params: { nodeIds: [a, b], resultId: "n_x" } }))).toBe(
      "core.boolean.noOverlap",
    );
  });

  it("拒绝：少于两个、跨父级、不支持类型、锁定", () => {
    const { store, pageId, add } = setup();
    const a = add({ x: 0, y: 0, width: 20, height: 20 });
    const b = add({ x: 10, y: 0, width: 20, height: 20 });
    expect(codeOf(() => store.apply({ type: "boolean.union", params: { nodeIds: [a], resultId: "n_1" } }))).toBe(
      "core.boolean.single",
    );

    const frame = createNode("frame", { x: 300, y: 0, width: 200, height: 200 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    const inner = createNode("rect", { width: 20, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [inner], parentId: frame.id } });
    expect(
      codeOf(() => store.apply({ type: "boolean.union", params: { nodeIds: [a, inner.id], resultId: "n_2" } })),
    ).toBe("core.boolean.crossParent");

    const text = createNode("text", { text: "hi" });
    store.apply({ type: "node.create", params: { nodes: [text], parentId: pageId } });
    expect(
      codeOf(() => store.apply({ type: "boolean.union", params: { nodeIds: [a, text.id], resultId: "n_3" } })),
    ).toBe("core.boolean.unsupportedType");

    store.apply({ type: "node.update", params: { nodeId: b, patch: { locked: true } } });
    expect(codeOf(() => store.apply({ type: "boolean.union", params: { nodeIds: [a, b], resultId: "n_4" } }))).toBe(
      "core.boolean.locked",
    );
  });

  it("结果继承基准层的布局尺寸行为", () => {
    const { store, add } = setup();
    const a = add({ x: 0, y: 0, width: 40, height: 40 });
    const b = add({ x: 20, y: 0, width: 40, height: 40 });
    store.apply({ type: "node.update", params: { nodeId: b, patch: { layoutSizingW: "fill" } } });
    store.apply({ type: "boolean.union", params: { nodeIds: [a, b], resultId: "n_layout" } });
    expect(store.doc.nodes["n_layout"].layoutSizingW).toBe("fill");
  });
});

describe("转路径命令", () => {
  it("矩形原地转 path：id / 样式 / 位置不变，撤销恢复矩形", () => {
    const { store, add } = setup();
    const id = add({ name: "Card", x: 10, y: 20, width: 100, height: 50, style: { fill: { value: "#3366ff" } } });
    store.apply({ type: "node.convertToPath", params: { nodeIds: [id] } });
    const node = store.doc.nodes[id];
    expect(node.type).toBe("path");
    expect(node.x).toBe(10);
    expect(node.y).toBe(20);
    expect(node.width).toBe(100);
    expect(node.height).toBe(50);
    expect(node.style.fill).toEqual({ value: "#3366ff" });
    expect(node.vector?.fillRule).toBe("nonzero");
    expect(node.vector?.contours).toHaveLength(1);
    expect(node.vector?.contours[0].anchors).toHaveLength(4);

    store.undo();
    expect(store.doc.nodes[id].type).toBe("rect");
    expect(store.doc.nodes[id].vector).toBeUndefined();
  });

  it("圆角矩形转出圆弧手柄", () => {
    const { store, add } = setup();
    const id = add({ width: 100, height: 100, style: { cornerRadius: { topLeft: 10, topRight: 10, bottomRight: 10, bottomLeft: 10 } } });
    store.apply({ type: "node.convertToPath", params: { nodeIds: [id] } });
    const anchors = store.doc.nodes[id].vector!.contours[0].anchors;
    expect(anchors).toHaveLength(8);
    expect(anchors.some((a) => a.inX !== 0 || a.outX !== 0 || a.inY !== 0 || a.outY !== 0)).toBe(true);
  });

  it("椭圆 / 多边形 / 直线都能转，尺寸保持", () => {
    const { store, pageId } = setup();
    const ellipse = createNode("ellipse", { width: 80, height: 40 });
    const polygon = createNode("polygon", { width: 60, height: 60, sides: 5 });
    const line = createNode("line", { width: 100, height: 30 });
    store.apply({ type: "node.create", params: { nodes: [ellipse, polygon, line], parentId: pageId } });
    store.apply({ type: "node.convertToPath", params: { nodeIds: [ellipse.id, polygon.id, line.id] } });

    const e = store.doc.nodes[ellipse.id];
    expect(e.type).toBe("path");
    expect(e.width).toBe(80);
    expect(e.height).toBe(40);
    expect(e.vector?.contours[0].anchors).toHaveLength(4);

    const p = store.doc.nodes[polygon.id];
    expect(p.type).toBe("path");
    expect(p.vector?.contours[0].anchors).toHaveLength(5);
    expect(p.sides).toBeUndefined();

    const l = store.doc.nodes[line.id];
    expect(l.type).toBe("path");
    expect(l.vector?.contours[0].closed).toBe(false);
    expect(l.vector?.contours[0].anchors).toHaveLength(2);
  });

  it("不支持的类型与锁定节点按错误码拒绝", () => {
    const { store, pageId } = setup();
    const text = createNode("text", { text: "hi" });
    store.apply({ type: "node.create", params: { nodes: [text], parentId: pageId } });
    expect(codeOf(() => store.apply({ type: "node.convertToPath", params: { nodeIds: [text.id] } }))).toBe(
      "core.convert.unsupportedType",
    );

    const lockedRect = createNode("rect", { width: 100, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [lockedRect], parentId: pageId } });
    store.apply({ type: "node.update", params: { nodeId: lockedRect.id, patch: { locked: true } } });
    expect(
      codeOf(() => store.apply({ type: "node.convertToPath", params: { nodeIds: [lockedRect.id] } })),
    ).toBe("core.convert.locked");
  });
});

describe("实例内部守卫", () => {
  /** 画板 + 两个矩形 → 主组件 → 页面上的实例；返回实例内的两个矩形 id。 */
  function withInstance() {
    const store = new DocStore(createDocWithPage());
    const pageId = firstPageId(store.doc)!;
    const frame = createNode("frame", { name: "卡片", x: 0, y: 0, width: 200, height: 200 });
    const innerA = createNode("rect", { name: "A", x: 10, y: 10, width: 50, height: 50 });
    const innerB = createNode("rect", { name: "B", x: 40, y: 40, width: 50, height: 50 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    store.apply({ type: "node.create", params: { nodes: [innerA], parentId: frame.id } });
    store.apply({ type: "node.create", params: { nodes: [innerB], parentId: frame.id } });
    store.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
    const instanceId = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: frame.id, parentId: pageId, nodeId: instanceId, x: 0, y: 0 },
    });
    const children = store.doc.nodes[instanceId].children;
    return { store, instanceId, masterId: frame.id, innerA, children };
  }

  it("实例内的形状不能做布尔运算", () => {
    const { store, children } = withInstance();
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(
      codeOf(() =>
        store.apply({ type: "boolean.union", params: { nodeIds: children.slice(0, 2), resultId: "n_inst_bool" } }),
      ),
    ).toBe("core.boolean.instanceInterior");
    expect(store.doc.nodes["n_inst_bool"]).toBeUndefined();
  });

  it("实例内的形状不能转为路径", () => {
    const { store, children } = withInstance();
    expect(codeOf(() => store.apply({ type: "node.convertToPath", params: { nodeIds: [children[0]!] } }))).toBe(
      "core.convert.instanceInterior",
    );
    expect(store.doc.nodes[children[0]!].type).toBe("rect");
  });

  it("母版内部的形状仍可布尔与转路径（结果由实例同步接管）", () => {
    const { store, masterId, innerA } = withInstance();
    const sibling = store.doc.nodes[masterId].children.find((id) => id !== innerA.id)!;
    store.apply({ type: "boolean.union", params: { nodeIds: [innerA.id, sibling], resultId: "n_master_bool" } });
    expect(store.doc.nodes["n_master_bool"].type).toBe("path");
    // 母版里的普通形状转路径同样允许
    const extra = createNode("rect", { width: 20, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [extra], parentId: masterId } });
    store.apply({ type: "node.convertToPath", params: { nodeIds: [extra.id] } });
    expect(store.doc.nodes[extra.id].type).toBe("path");
  });
});
