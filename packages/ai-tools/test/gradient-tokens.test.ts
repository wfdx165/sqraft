import { describe, expect, it } from "vitest";
import type { GradientValue } from "@sqraft/core";
import { call, setup } from "./helpers";

const gradient: GradientValue = {
  type: "linear",
  from: { x: 0, y: 0.5 },
  to: { x: 1, y: 0.5 },
  stops: [
    { offset: 0, color: { value: "#6366f1" } },
    { offset: 1, color: { value: "#a855f7" } },
  ],
};

describe("AI 工具：渐变 Token", () => {
  it("define_token 接受渐变值并归一化", async () => {
    const { store, run } = setup();
    await call(run, "define_token", {
      path: "gradient/brand",
      type: "gradient",
      value: {
        ...gradient,
        stops: [
          { offset: 3, color: { value: "#ffffff" } },
          { offset: -1, color: { value: "#000000" } },
        ],
      },
    });
    const entry = store.doc.tokens["gradient/brand"];
    expect(entry?.type).toBe("gradient");
    expect((entry?.value as GradientValue).stops.map((stop) => stop.offset)).toEqual([0, 1]);
  });

  it("渐变结构不合法时给出可读错误", async () => {
    const { run } = setup();
    await expect(
      run("define_token", { path: "gradient/bad", type: "gradient", value: { type: "conic" } }),
    ).rejects.toThrow(/渐变 .* 不合法/);
  });

  it("色标引用不存在的 Token 时拒绝", async () => {
    const { run } = setup();
    await expect(
      run("define_token", {
        path: "gradient/bad",
        type: "gradient",
        value: { ...gradient, stops: [{ offset: 0, color: { token: "color/missing" } }, gradient.stops[1]] },
      }),
    ).rejects.toThrow(/不存在的 Token/);
  });

  it("严格模式：字面色标被拒，改成颜色 Token 后可写", async () => {
    const { store, run } = setup();
    await call(run, "define_token", { path: "color/a", type: "color", value: "#6366f1" });
    await call(run, "define_token", { path: "color/b", type: "color", value: "#a855f7" });
    store.apply({ type: "doc.setStrictTokens", params: { value: true } }, "strict-tokens");

    await expect(
      run("define_token", { path: "gradient/brand", type: "gradient", value: gradient }),
    ).rejects.toThrow(/^TOKEN_REQUIRED: gradient token stops/);

    await call(run, "define_token", {
      path: "gradient/brand",
      type: "gradient",
      value: {
        ...gradient,
        stops: [
          { offset: 0, color: { token: "color/a" } },
          { offset: 1, color: { token: "color/b" } },
        ],
      },
    });
    expect(store.doc.tokens["gradient/brand"]?.type).toBe("gradient");
  });

  it("fillToken 可以指向渐变 Token", async () => {
    const { store, run } = setup();
    await call(run, "define_token", { path: "gradient/brand", type: "gradient", value: gradient });
    const created = await call(run, "create_node", { kind: "rect", fillToken: "gradient/brand" });
    expect(store.doc.nodes[created.nodeId as string].style.fill).toEqual({ token: "gradient/brand" });
  });

  it("read_document 展开渐变 Token 引用", async () => {
    const { run } = setup();
    await call(run, "define_token", { path: "gradient/brand", type: "gradient", value: gradient });
    const created = await call(run, "create_node", { kind: "rect", fillToken: "gradient/brand" });
    const doc = await call(run, "read_document", { scope: "subtree", subtreeId: created.nodeId, depth: 0 });
    const node = (doc.nodes as Array<Record<string, unknown>>)[0];
    expect(node.style).toEqual({ fill: { token: "gradient/brand" } });
    expect(node.tokenGradients).toEqual({ fill: gradient });
  });

  it("不能把已有 Token 改成渐变，也不能把渐变 Token 改成颜色", async () => {
    const { run } = setup();
    await call(run, "define_token", { path: "brand/hero", type: "color", value: "#3366ff" });
    await expect(
      run("define_token", { path: "brand/hero", type: "gradient", value: gradient }),
    ).rejects.toThrow(/不能改成 gradient/);
  });
});

describe("AI 工具：只被渐变 Token 引用的颜色 Token", () => {
  it("删除时提示会影响哪些渐变 Token", async () => {
    const { run } = setup();
    await call(run, "define_token", { path: "color/a", type: "color", value: "#6366f1" });
    await call(run, "define_token", {
      path: "gradient/brand",
      type: "gradient",
      value: { ...gradient, stops: [{ offset: 0, color: { token: "color/a" } }, gradient.stops[1]] },
    });
    await expect(run("delete_token", { path: "color/a" })).rejects.toThrow(/另有 1 个渐变 Token/);
  });
});
