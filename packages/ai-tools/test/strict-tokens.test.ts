import { describe, expect, it } from "vitest";
import { call, createNode, setup, type DocStore } from "./helpers";

/** 开启文档级严格模式：与设计系统面板的开关走同一条命令。 */
function enableStrict(store: DocStore): void {
  store.apply({ type: "doc.setStrictTokens", params: { value: true } }, "strict-tokens");
}

describe("Token 严格模式（ADR-0035）", () => {
  it("默认关闭：字面量照写，ADR-0024 的宽松行为不变", async () => {
    const { store, run } = setup();
    const res = await call(run, "create_node", { kind: "rect", fill: "#3366ff" });
    expect(store.doc.nodes[res.nodeId as string].style.fill).toEqual({ value: "#3366ff" });
  });

  it("开启后 create_node 写字面量被拒，文档无变更、撤销栈不新增", async () => {
    const { store, run } = setup();
    enableStrict(store);
    const before = Object.keys(store.doc.nodes).length;
    const label = store.undoLabel;

    await expect(run("create_node", { kind: "rect", fill: "#3366ff" })).rejects.toThrow(
      /^TOKEN_REQUIRED: fill must reference a token/,
    );
    expect(Object.keys(store.doc.nodes)).toHaveLength(before);
    expect(store.undoLabel).toBe(label);
  });

  it("stroke 同样被拦", async () => {
    const { store, run } = setup();
    enableStrict(store);
    await expect(run("create_node", { kind: "rect", stroke: "#1a1a1a" })).rejects.toThrow(
      /^TOKEN_REQUIRED: stroke must reference a token/,
    );
  });

  it("给出 3 个按色距最近的 Token，ΔE 升序，数值 Token 不参与", async () => {
    const { store, run } = setup();
    await call(run, "define_token", { path: "color/brand", type: "color", value: "#3366ff" });
    await call(run, "define_token", { path: "color/brand-soft", type: "color", value: "#4477ff" });
    await call(run, "define_token", { path: "color/ink", type: "color", value: "#111111" });
    await call(run, "define_token", { path: "size/body", type: "number", value: 14 });
    enableStrict(store);

    let message = "";
    try {
      await run("create_node", { kind: "rect", fill: "#3370ff" });
    } catch (err) {
      message = String(err instanceof Error ? err.message : err);
    }
    expect(message.startsWith("TOKEN_REQUIRED: fill must reference a token. nearest tokens:")).toBe(true);
    expect(message).toContain("color/brand #3366ff");
    expect(message).not.toContain("size/body");

    const deltas = [...message.matchAll(/ΔE ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(deltas).toHaveLength(3);
    expect(deltas[0]).toBeLessThanOrEqual(deltas[1]);
    expect(deltas[1]).toBeLessThanOrEqual(deltas[2]);
    // OKLab 的 ΔE 是 0–1 量级：必须 ×100 展示，否则两个差别明显的 Token 会一起显示成 0.0
    // （这里 #3370ff 与 color/brand 几乎同色 → 个位数；与 color/ink 差得远 → 40+）
    expect(deltas[0]).toBeLessThan(10);
    expect(deltas[2]).toBeGreaterThan(20);
    expect(new Set(deltas).size).toBe(3);
  });

  it("文档没有颜色 Token 时提示先 define_token", async () => {
    const { store, run } = setup();
    enableStrict(store);
    await expect(run("create_node", { kind: "rect", fill: "#3366ff" })).rejects.toThrow(
      /no color tokens\. call define_token first\./,
    );
  });

  it("fillToken 引用存在时通过；与字面量同时给时 Token 优先、不报错", async () => {
    const { store, run } = setup();
    await call(run, "define_token", { path: "color/brand", type: "color", value: "#3366ff" });
    enableStrict(store);

    const only = await call(run, "create_node", { kind: "rect", fillToken: "color/brand" });
    expect(store.doc.nodes[only.nodeId as string].style.fill).toEqual({ token: "color/brand" });

    const both = await call(run, "create_node", { kind: "rect", fillToken: "color/brand", fill: "#000000" });
    expect(store.doc.nodes[both.nodeId as string].style.fill).toEqual({ token: "color/brand" });
  });

  it("数字字面量不受影响（字号 / 圆角 / 间距仍可直接写）", async () => {
    const { store, run } = setup();
    enableStrict(store);
    const res = await call(run, "create_node", {
      kind: "text",
      text: "hi",
      fontSize: 20,
      cornerRadius: 4,
    });
    const node = store.doc.nodes[res.nodeId as string];
    expect(node.style.fontSize).toBe(20);
    // 模型里圆角统一归一成四角对象
    expect(node.style.cornerRadius).toEqual({ topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 });
  });

  it("update_node 同样被拦", async () => {
    const { store, run } = setup();
    const created = await call(run, "create_node", { kind: "rect" });
    enableStrict(store);
    await expect(
      run("update_node", { nodeId: created.nodeId, fill: "#3366ff" }),
    ).rejects.toThrow(/^TOKEN_REQUIRED: fill/);
  });

  it("create_nodes 的子节点也被拦，错误带条目路径", async () => {
    const { store, run } = setup();
    enableStrict(store);
    await expect(
      run("create_nodes", {
        nodes: [{ id: "a", kind: "frame", children: [{ id: "b", kind: "rect", fill: "#3366ff" }] }],
      }),
    ).rejects.toThrow(/nodes\[0\]\.children\[0\]：TOKEN_REQUIRED: fill/);
    expect(store.doc.nodes.a).toBeUndefined();
  });

  it("只拦工具入参：直接写进文档的手选色不受影响", () => {
    const { store } = setup();
    enableStrict(store);
    const rect = createNode("rect", { style: { fill: { value: "#3366ff" } } });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: store.doc.rootIds[0] } });
    expect(store.doc.nodes[rect.id].style.fill).toEqual({ value: "#3366ff" });
  });
});
