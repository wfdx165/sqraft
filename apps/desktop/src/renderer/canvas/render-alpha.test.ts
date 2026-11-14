import { describe, expect, it } from "vitest";
import { createEmptyDoc, createNode, DocStore, type DocNode } from "@sqraft/core";
import { drawDocument, type RenderBackend } from "@sqraft/render";

/** 只记录"开了几张不透明度离屏 / 几次直接乘 alpha"。 */
function counting(): { backend: RenderBackend; layers: number[]; direct: number[] } {
  const layers: number[] = [];
  const direct: number[] = [];
  const noop = () => {};
  const backend = new Proxy({} as RenderBackend, {
    get: (_t, key) => {
      if (key === "pushOpacity") return (alpha: number) => layers.push(alpha);
      if (key === "pushAlpha") return (alpha: number) => direct.push(alpha);
      return noop;
    },
  });
  return { backend, layers, direct };
}

function drawOne(node: DocNode, children: DocNode[] = []) {
  const store = new DocStore(createEmptyDoc());
  const page = createNode("page", { name: "P", x: 0, y: 0, width: 500, height: 500 });
  store.apply({ type: "node.create", params: { nodes: [page], parentId: null } });
  store.apply({ type: "node.create", params: { nodes: [node], parentId: page.id } });
  if (children.length) store.apply({ type: "node.create", params: { nodes: children, parentId: node.id } });
  const c = counting();
  drawDocument(c.backend, store.doc);
  return c;
}

describe("半透明叶子节点不开离屏", () => {
  it("只有填充的矩形 / 不带描边的文本 / 图片：直接乘 alpha", () => {
    const rect = createNode("rect", { name: "r", x: 0, y: 0, width: 10, height: 10, opacity: 0.3, style: { fill: { value: "#f00" } } });
    expect(drawOne(rect)).toMatchObject({ layers: [], direct: [0.3] });
    const text = createNode("text", { name: "t", x: 0, y: 0, width: 50, height: 20, opacity: 0.5, text: "hi", style: { fill: { value: "#000" } } });
    expect(drawOne(text)).toMatchObject({ layers: [], direct: [0.5] });
  });

  it("填充 + 描边、带下划线的文本、带效果、有子节点：仍走离屏（结果才与组隔离一致）", () => {
    const both = createNode("rect", {
      name: "r", x: 0, y: 0, width: 10, height: 10, opacity: 0.3,
      style: { fill: { value: "#f00" }, stroke: { value: "#000" }, strokeWidth: 2 },
    });
    expect(drawOne(both)).toMatchObject({ layers: [0.3], direct: [] });
    const underlined = createNode("text", {
      name: "t", x: 0, y: 0, width: 50, height: 20, opacity: 0.5, text: "hi",
      style: { fill: { value: "#000" }, textDecoration: "underline" },
    });
    expect(drawOne(underlined)).toMatchObject({ layers: [0.5], direct: [] });
    const shadowed = createNode("rect", {
      name: "r", x: 0, y: 0, width: 10, height: 10, opacity: 0.3,
      style: { fill: { value: "#f00" }, effects: [{ type: "drop-shadow", visible: true, x: 0, y: 2, blur: 4, spread: 0, color: { value: "#000" } }] },
    });
    expect(drawOne(shadowed).layers).toEqual([0.3]);
    const group = createNode("group", { name: "g", x: 0, y: 0, width: 20, height: 20, opacity: 0.4 });
    const child = createNode("rect", { name: "c", x: 0, y: 0, width: 10, height: 10, style: { fill: { value: "#f00" } } });
    expect(drawOne(group, [child])).toMatchObject({ layers: [0.4], direct: [] });
  });
});
