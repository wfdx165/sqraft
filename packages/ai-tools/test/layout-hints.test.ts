import { describe, expect, it } from "vitest";
import { call, createDocWithPage, createNode, DocStore, firstPageId, makeExecutor } from "./helpers";
import { attachLayoutHints } from "../src/layout-hints";

interface SeedKid {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

interface HintRow {
  nodeId: string;
  direction: string;
  children: number;
  suggested: Record<string, unknown>;
}

/**
 * 造一个没有自动布局的 frame：`create_node` 会给新建画板开布局，
 * 这里直接走 core，模拟"老文件里手摆的容器"。
 */
function seed(kids: SeedKid[]) {
  const store = new DocStore(createDocWithPage());
  const pageId = firstPageId(store.doc)!;
  const frame = createNode("frame", { name: "Card", x: 40, y: 40, width: 240, height: 320 });
  store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
  const kidIds: string[] = [];
  for (const [index, kid] of kids.entries()) {
    const node = createNode("text", {
      name: `Line ${index + 1}`,
      text: `Line ${index + 1}`,
      style: { fill: { value: "#111111" } },
      width: kid.width ?? 208,
      height: kid.height ?? 24,
      x: kid.x,
      y: kid.y,
    });
    store.apply({ type: "node.create", params: { nodes: [node], parentId: frame.id } });
    kidIds.push(node.id);
  }
  const run = makeExecutor(store, async () => "", () => pageId);
  return { store, run, pageId, frameId: frame.id, kidIds };
}

describe("AI 工具：自动布局建议", () => {
  it("子项等距排成一列时给出可直接套用的 layout", async () => {
    const { run, frameId } = seed([
      { x: 16, y: 16 },
      { x: 16, y: 56 },
    ]);
    const res = await call(run, "create_node", {
      kind: "rect",
      parentId: frameId,
      x: 16,
      y: 96,
      width: 208,
      height: 24,
    });
    const hints = res.layoutHints as HintRow[];
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({
      nodeId: frameId,
      direction: "vertical",
      children: 3,
      suggested: {
        direction: "vertical",
        gap: 16,
        padding: { top: 16, right: 16, bottom: 200, left: 16 },
        crossAlign: "start",
      },
    });
  });

  it("按 suggested 加上布局后几何不变（建议不是「重排」）", async () => {
    const { store, run, frameId } = seed([
      { x: 16, y: 16 },
      { x: 16, y: 56 },
    ]);
    await call(run, "create_node", {
      kind: "rect",
      parentId: frameId,
      x: 16,
      y: 96,
      width: 208,
      height: 24,
    });
    const res = await call(run, "create_node", {
      kind: "rect",
      parentId: frameId,
      x: 16,
      y: 136,
      width: 208,
      height: 24,
    });
    const hints = res.layoutHints as HintRow[];
    const before = store.doc.nodes[frameId].children.map((id) => ({
      x: store.doc.nodes[id].x,
      y: store.doc.nodes[id].y,
      width: store.doc.nodes[id].width,
      height: store.doc.nodes[id].height,
    }));

    await call(run, "update_node", { nodeId: frameId, layout: hints[0].suggested });

    const after = store.doc.nodes[frameId].children.map((id) => ({
      x: store.doc.nodes[id].x,
      y: store.doc.nodes[id].y,
      width: store.doc.nodes[id].width,
      height: store.doc.nodes[id].height,
    }));
    expect(after).toEqual(before);
    expect(store.doc.nodes[frameId].layout).toMatchObject({ direction: "vertical", gap: 16 });
  });

  it("间距不均匀时不提示（一个 gap 还原不了原来的摆放）", async () => {
    const { run, frameId } = seed([
      { x: 16, y: 16 },
      { x: 16, y: 56 },
    ]);
    const res = await call(run, "create_node", {
      kind: "rect",
      parentId: frameId,
      x: 16,
      y: 120,
      width: 208,
      height: 24,
    });
    expect(res.layoutHints).toBeUndefined();
  });

  it("交叉轴没对齐时不提示", async () => {
    const { run, frameId } = seed([
      { x: 16, y: 16 },
      { x: 40, y: 56 },
    ]);
    const res = await call(run, "create_node", {
      kind: "rect",
      parentId: frameId,
      x: 16,
      y: 96,
      width: 208,
      height: 24,
    });
    expect(res.layoutHints).toBeUndefined();
  });

  it("少于三个子项时不提示", async () => {
    const { run, frameId } = seed([{ x: 16, y: 16 }]);
    const res = await call(run, "create_node", {
      kind: "rect",
      parentId: frameId,
      x: 16,
      y: 56,
      width: 208,
      height: 24,
    });
    expect(res.layoutHints).toBeUndefined();
  });

  it("已经有自动布局的容器不提示", async () => {
    const { run } = seed([]);
    const frame = await call(run, "create_node", { kind: "frame", width: 240, height: 320 });
    for (let index = 0; index < 3; index++) {
      await call(run, "create_node", {
        kind: "rect",
        parentId: frame.nodeId,
        x: 10,
        y: 10 + index * 30,
        width: 200,
        height: 20,
      });
    }
    const res = await call(run, "create_node", {
      kind: "rect",
      parentId: frame.nodeId,
      width: 200,
      height: 20,
    });
    expect(res.layoutHints).toBeUndefined();
  });

  it("只改子项内容时不重复提醒", async () => {
    const { run, kidIds } = seed([
      { x: 16, y: 16 },
      { x: 16, y: 56 },
      { x: 16, y: 96 },
    ]);
    const res = await call(run, "update_node", { nodeId: kidIds[1], text: "Changed" });
    expect(res.layoutHints).toBeUndefined();
  });

  it("刚对齐/分布过（arrange_nodes）也提示：这才是最该换布局的时刻", async () => {
    const { run, kidIds } = seed([
      { x: 16, y: 16 },
      { x: 40, y: 56 },
      { x: 16, y: 96 },
    ]);
    const res = await call(run, "arrange_nodes", { nodeIds: kidIds, action: "align-left" });
    const hints = res.layoutHints as HintRow[];
    expect(hints).toHaveLength(1);
    expect(hints[0].suggested).toMatchObject({ direction: "vertical", gap: 16 });
  });

  it("import_svg 的产物是插画，不提示", () => {
    const { store, frameId, kidIds } = seed([
      { x: 16, y: 16 },
      { x: 16, y: 56 },
      { x: 16, y: 96 },
    ]);
    const raw = JSON.stringify({ ok: true });
    const changed = new Set([frameId, ...kidIds]);
    expect(attachLayoutHints(store, raw, changed, "import_svg")).toBe(raw);
    expect(attachLayoutHints(store, raw, changed, "create_node")).not.toBe(raw);
  });
});
