import { describe, expect, it } from "vitest";
import { createEmptyDoc, DocStore, firstPageId } from "@sqraft/core";
import { makeExecutor, type ToolExecutor } from "../src/index";

/** 每个用例一份干净文档 + 执行器（getActivePageId 固定为第一页）。 */
function setup(): { store: DocStore; run: ToolExecutor; pageId: string } {
  const store = new DocStore(createEmptyDoc());
  const pageId = firstPageId(store.doc)!;
  const run = makeExecutor(store, async () => "", () => pageId);
  return { store, run, pageId };
}

async function call(run: ToolExecutor, name: string, args: Record<string, unknown> = {}) {
  return JSON.parse(await run(name, args)) as Record<string, unknown>;
}

describe("AI 工具：路径", () => {
  it("create_node 用父容器坐标建路径，节点框由包围盒推导", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_node", {
      kind: "path",
      points: [
        { x: 30, y: 40 },
        { x: 130, y: 40 },
        { x: 130, y: 90 },
      ],
    });
    const node = store.doc.nodes[res.nodeId as string];
    expect(node.type).toBe("path");
    expect(node.vector?.closed).toBe(false);
    expect(node.x).toBe(30);
    expect(node.y).toBe(40);
    expect(node.width).toBe(100);
    expect(node.height).toBe(50);
    expect(node.vector?.anchors[0]).toMatchObject({ x: 0, y: 0 });
    // 未给颜色时开放路径默认描边
    expect(node.style.stroke).toEqual({ token: "color/text" });
    expect(node.style.strokeWidth).toBe(2);
  });

  it("闭合路径默认填充，且至少 3 个锚点", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_node", {
      kind: "path",
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 50, y: 80 },
      ],
    });
    expect(store.doc.nodes[res.nodeId as string].style.fill).toEqual({ token: "color/primary" });
    await expect(
      run("create_node", {
        kind: "path",
        closed: true,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      }),
    ).rejects.toThrow(/闭合路径至少需要 3 个锚点/);
  });

  it("points 缺失或坐标非数值时拒绝", async () => {
    const { run } = setup();
    await expect(run("create_node", { kind: "path" })).rejects.toThrow(/必须提供 points/);
    await expect(
      run("create_node", { kind: "path", points: [{ x: 0, y: 0 }, { x: 10, y: Number.NaN }] }),
    ).rejects.toThrow(/x\/y 必须是数值/);
  });

  it("update_node 的 points 按节点位置换算成本地坐标，撤销可恢复", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", {
      kind: "path",
      points: [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ],
    });
    const id = created.nodeId as string;
    await call(run, "update_node", {
      nodeId: id,
      points: [
        { x: 100, y: 100 },
        { x: 100, y: 260 },
      ],
      closed: false,
    });
    expect(store.doc.nodes[id].vector?.anchors[1]).toMatchObject({ x: 0, y: 160 });
    store.undo();
    expect(store.doc.nodes[id].width).toBe(100);
    expect(store.doc.nodes[id].vector?.anchors[1]).toMatchObject({ x: 100, y: 0 });
  });

  it("points / closed 只适用于 path", async () => {
    const { run } = setup();
    const rect = await call(run, "create_node", { kind: "rect" });
    await expect(
      run("update_node", { nodeId: rect.nodeId, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }),
    ).rejects.toThrow(/points 仅适用于 path/);
    await expect(run("update_node", { nodeId: rect.nodeId, closed: true })).rejects.toThrow(/closed 仅适用于 path/);
  });

  it("read_document 回传 vector", async () => {
    const { run } = setup();
    const created = await call(run, "create_node", {
      kind: "path",
      points: [
        { x: 0, y: 0 },
        { x: 40, y: 40 },
      ],
    });
    const doc = await call(run, "read_document");
    const pages = doc.pages as Array<{ subtree: string }>;
    const flat = JSON.parse(pages[0].subtree) as Array<{ id: string; vector?: { anchors: unknown[] } }>;
    expect(flat.find((n) => n.id === created.nodeId)?.vector?.anchors).toHaveLength(2);
  });
});

describe("AI 工具：多边形", () => {
  it("sides 缺省为 3，按边数命名", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", { kind: "polygon", x: 10, y: 20, width: 120, height: 90 });
    const node = store.doc.nodes[created.nodeId as string];
    expect(node.type).toBe("polygon");
    expect(node.sides).toBe(3);
    expect(node.name).toBe("三角形");
    expect(node.style.fill).toEqual({ token: "color/primary" });
  });

  it("边数夹紧到 3–12，非 3 时叫多边形", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", { kind: "polygon", sides: 40 });
    expect(store.doc.nodes[created.nodeId as string].sides).toBe(12);
    expect(store.doc.nodes[created.nodeId as string].name).toBe("多边形");
    await call(run, "update_node", { nodeId: created.nodeId, sides: 5 });
    expect(store.doc.nodes[created.nodeId as string].sides).toBe(5);
  });

  it("sides 只适用于 polygon", async () => {
    const { run } = setup();
    await expect(run("create_node", { kind: "rect", sides: 5 })).rejects.toThrow(/sides 仅适用于 kind=polygon/);
    const rect = await call(run, "create_node", { kind: "rect" });
    await expect(run("update_node", { nodeId: rect.nodeId, sides: 4 })).rejects.toThrow(/sides 仅适用于 polygon/);
  });

  it("read_document 回传 sides", async () => {
    const { run } = setup();
    const created = await call(run, "create_node", { kind: "polygon", sides: 6 });
    const doc = await call(run, "read_document");
    const pages = doc.pages as Array<{ subtree: string }>;
    const flat = JSON.parse(pages[0].subtree) as Array<{ id: string; sides?: number }>;
    expect(flat.find((n) => n.id === created.nodeId)?.sides).toBe(6);
  });
});

describe("AI 工具：样式纪律", () => {
  it("字面量色值被拒绝，Token 引用通过", async () => {
    const { run } = setup();
    await expect(run("create_node", { kind: "rect", fillToken: "#ff0000" })).rejects.toThrow(/禁止使用字面量色值/);
    await expect(
      run("create_node", { kind: "path", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], strokeToken: "#ff0000" }),
    ).rejects.toThrow(/禁止使用字面量色值/);
    await expect(
      run("create_node", { kind: "rect", fillToken: "color/primary" }),
    ).resolves.toContain("nodeId");
  });

  it("只改描边时保留原有填充（style 整体替换但先展开旧值）", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", { kind: "rect", fillToken: "color/primary" });
    const id = created.nodeId as string;
    await call(run, "update_node", { nodeId: id, strokeToken: "color/text", strokeWidth: 3 });
    expect(store.doc.nodes[id].style.fill).toEqual({ token: "color/primary" });
    expect(store.doc.nodes[id].style.stroke).toEqual({ token: "color/text" });
    expect(store.doc.nodes[id].style.strokeWidth).toBe(3);
  });
});
