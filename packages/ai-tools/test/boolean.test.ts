import { describe, expect, it } from "vitest";
import { call, setup } from "./helpers";
import { tools } from "../src/tools";

const BOX = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

describe("AI 工具：多轮廓读写", () => {
  it("create_node 用 contours 建带洞路径，read_document 原样读回", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_node", {
      kind: "path",
      contours: [
        { closed: true, anchors: BOX(0, 0, 100, 100) },
        { closed: true, anchors: BOX(30, 30, 40, 40) },
      ],
      fillRule: "evenodd",
      fill: "#3366ff",
    });
    const node = store.doc.nodes[res.nodeId as string];
    expect(node.vector?.contours).toHaveLength(2);
    expect(node.vector?.fillRule).toBe("evenodd");

    const doc = await call(run, "read_document");
    const flat = doc.nodes as Array<{ id: string; vector?: { contours: unknown[]; fillRule: string } }>;
    const found = flat.find((entry) => entry.id === res.nodeId);
    expect(found?.vector?.contours).toHaveLength(2);
    expect(found?.vector?.fillRule).toBe("evenodd");
  });

  it("update_node 的 contours 整体替换；fillRule 可单独改", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_node", {
      kind: "path",
      contours: [
        { closed: true, anchors: BOX(0, 0, 100, 100) },
        { closed: true, anchors: BOX(30, 30, 40, 40) },
      ],
      fillRule: "evenodd",
    });
    await call(run, "update_node", {
      nodeId: res.nodeId,
      contours: [{ closed: true, anchors: BOX(0, 0, 50, 50) }],
    });
    const node = store.doc.nodes[res.nodeId as string];
    expect(node.vector?.contours).toHaveLength(1);
    expect(node.vector?.fillRule).toBe("evenodd");

    await call(run, "update_node", { nodeId: res.nodeId, fillRule: "nonzero" });
    expect(store.doc.nodes[res.nodeId as string].vector?.fillRule).toBe("nonzero");
  });

  it("多轮廓路径上写 points 被拒绝，避免静默丢洞", async () => {
    const { run } = setup();
    const res = await call(run, "create_node", {
      kind: "path",
      contours: [
        { closed: true, anchors: BOX(0, 0, 100, 100) },
        { closed: true, anchors: BOX(30, 30, 40, 40) },
      ],
      fillRule: "evenodd",
    });
    await expect(
      run("update_node", { nodeId: res.nodeId, points: BOX(0, 0, 10, 10) }),
    ).rejects.toThrow(/core\.path\.multiContour/);
  });

  it("contours 与 points 不能同时给", async () => {
    const { run } = setup();
    await expect(
      run("create_node", {
        kind: "path",
        points: BOX(0, 0, 10, 10),
        contours: [{ closed: true, anchors: BOX(0, 0, 10, 10) }],
      }),
    ).rejects.toThrow(/不能同时给/);
  });

  it("contours 与 closed 不能同时给（create / update 一致）", async () => {
    const { run } = setup();
    await expect(
      run("create_node", {
        kind: "path",
        closed: true,
        contours: [{ closed: true, anchors: BOX(0, 0, 10, 10) }],
      }),
    ).rejects.toThrow(/contours 与 closed 不能同时给/);

    const created = await call(run, "create_node", {
      kind: "path",
      contours: [{ closed: true, anchors: BOX(0, 0, 10, 10) }],
    });
    await expect(
      run("update_node", {
        nodeId: created.nodeId,
        closed: false,
        contours: [{ closed: true, anchors: BOX(0, 0, 20, 20) }],
      }),
    ).rejects.toThrow(/contours 与 closed 不能同时给/);
  });
});

describe("AI 工具：boolean_op / convert_to_path", () => {
  it("工具表包含两个新工具", () => {
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("boolean_op");
    expect(names).toContain("convert_to_path");
    expect(names).toHaveLength(36);
  });

  it("并集：返回 styleFrom / mergedStyles / anchorCount，操作数被删除", async () => {
    const { store, run } = setup();
    const a = await call(run, "create_node", { kind: "rect", x: 0, y: 0, width: 100, height: 100, fill: "#ff0000" });
    const b = await call(run, "create_node", { kind: "rect", x: 50, y: 0, width: 100, height: 100, fill: "#0000ff" });
    const res = await call(run, "boolean_op", { op: "union", nodeIds: [a.nodeId, b.nodeId] });

    expect(res).toMatchObject({
      ok: true,
      op: "union",
      styleFrom: { nodeId: b.nodeId },
      mergedStyles: true,
    });
    expect(res.anchorCount).toBeGreaterThan(3);
    const result = store.doc.nodes[String(res.nodeId)];
    expect(result.type).toBe("path");
    expect(result.vector?.fillRule).toBe("evenodd");
    expect(result.style.fill).toEqual({ value: "#0000ff" });
    expect(store.doc.nodes[a.nodeId as string]).toBeUndefined();
    expect(store.doc.nodes[b.nodeId as string]).toBeUndefined();
  });

  it("填充一致时不出现 mergedStyles", async () => {
    const { run } = setup();
    const a = await call(run, "create_node", { kind: "rect", x: 0, y: 0, width: 100, height: 100, fill: "#ffffff" });
    const b = await call(run, "create_node", { kind: "rect", x: 40, y: 0, width: 100, height: 100, fill: "#ffffff" });
    const res = await call(run, "boolean_op", { op: "union", nodeIds: [a.nodeId, b.nodeId] });
    expect(res.mergedStyles).toBeUndefined();
  });

  it("差集：取最底层做被减数与样式来源，结果带洞", async () => {
    const { store, run } = setup();
    const bottom = await call(run, "create_node", { kind: "rect", x: 0, y: 0, width: 100, height: 100, fill: "#111111" });
    const top = await call(run, "create_node", { kind: "rect", x: 25, y: 25, width: 50, height: 50, fill: "#222222" });
    const res = await call(run, "boolean_op", { op: "subtract", nodeIds: [top.nodeId, bottom.nodeId] });
    expect(res.styleFrom).toMatchObject({ nodeId: bottom.nodeId });
    expect(store.doc.nodes[String(res.nodeId)].vector?.contours).toHaveLength(2);
  });

  it("convert_to_path 保持 id，之后可以改 contours", async () => {
    const { store, run } = setup();
    const rect = await call(run, "create_node", { kind: "rect", x: 10, y: 20, width: 100, height: 50, fill: "#3366ff" });
    const res = await call(run, "convert_to_path", { nodeIds: [rect.nodeId] });
    expect(res).toEqual({ ok: true, nodeIds: [rect.nodeId] });
    const node = store.doc.nodes[String(rect.nodeId)];
    expect(node.type).toBe("path");
    expect(node.x).toBe(10);
    expect(node.style.fill).toEqual({ value: "#3366ff" });
    await call(run, "update_node", { nodeId: rect.nodeId, contours: [{ closed: true, anchors: BOX(0, 0, 20, 20) }] });
    expect(store.doc.nodes[String(rect.nodeId)].vector?.contours).toHaveLength(1);
  });

  it("非法 op 与少于两个操作数被拒绝", async () => {
    const { run } = setup();
    const a = await call(run, "create_node", { kind: "rect" });
    await expect(run("boolean_op", { op: "merge", nodeIds: [a.nodeId, a.nodeId] })).rejects.toThrow(/op 必须是/);
    await expect(run("boolean_op", { op: "union", nodeIds: [a.nodeId] })).rejects.toThrow(/至少需要 2/);
  });
});
