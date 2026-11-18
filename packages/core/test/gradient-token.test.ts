import { describe, expect, it } from "vitest";
import {
  createDocWithPage,
  createNode,
  isGradientValue,
  resolveGradient,
  resolvePaint,
  resolvePaintSpec,
  type DocState,
  type GradientValue,
} from "../src/model";
import { CURRENT_FORMAT_VERSION, migrateDoc } from "../src/migrate";
import { DocStore } from "../src/store";
import { tokenGradientOf } from "../src/token-validation";
import { planTokenDelete } from "../src/token-refs";
import { diagnose } from "../src/diagnostics";

const linear: GradientValue = {
  type: "linear",
  from: { x: 0, y: 0.5 },
  to: { x: 1, y: 0.5 },
  stops: [
    { offset: 0, color: { token: "color/a" } },
    { offset: 1, color: { token: "color/b" } },
  ],
};

function storeWithGradientToken(): DocStore {
  const store = new DocStore(createDocWithPage());
  store.doc.tokens["color/a"] = { type: "color", value: "#6366f1" };
  store.doc.tokens["color/b"] = { type: "color", value: "#a855f7" };
  store.apply({
    type: "token.define",
    params: { path: "gradient/brand", tokenType: "gradient", value: linear },
  });
  return store;
}

function rectFilledWith(store: DocStore, paint: ReturnType<typeof createNode>["style"]["fill"]) {
  const pageId = store.doc.rootIds[0]!;
  const node = createNode("rect", { name: "R", style: { fill: paint } });
  store.apply({ type: "node.create", params: { nodes: [node], parentId: pageId } });
  return node;
}

describe("渐变 Token：校验", () => {
  it("接受合法值，夹住 offset 并升序保存", () => {
    const parsed = tokenGradientOf({
      ...linear,
      stops: [
        { offset: 1.4, color: { value: "#ffffff" } },
        { offset: -0.2, color: { value: "#000000" } },
      ],
    });
    expect(parsed?.stops.map((stop) => stop.offset)).toEqual([0, 1]);
  });

  it("色标少于 2 个、超过 16 个、颜色不合法或类型不对都拒绝", () => {
    expect(tokenGradientOf({ ...linear, stops: [linear.stops[0]] })).toBeNull();
    expect(
      tokenGradientOf({
        ...linear,
        stops: Array.from({ length: 17 }, (_, i) => ({ offset: i / 16, color: { value: "#000000" } })),
      }),
    ).toBeNull();
    expect(tokenGradientOf({ ...linear, stops: [{ offset: 0, color: { value: "rebeccapurple" } }] })).toBeNull();
    expect(tokenGradientOf({ ...linear, type: "conic" })).toBeNull();
    expect(tokenGradientOf({ ...linear, from: { x: 0 } })).toBeNull();
    expect(tokenGradientOf("linear")).toBeNull();
  });

  it("isGradientValue 只认结构，不校验色标数量", () => {
    expect(isGradientValue(linear)).toBe(true);
    expect(isGradientValue({ ...linear, stops: [] })).toBe(true);
    expect(isGradientValue({ type: "linear", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })).toBe(false);
  });
});

describe("渐变 Token：解析", () => {
  it("resolvePaintSpec 把 Token 展开成渐变，色标里的颜色 Token 一并解析", () => {
    const store = storeWithGradientToken();
    const spec = resolvePaintSpec(store.doc, { token: "gradient/brand" });
    expect(spec).toEqual({
      type: "gradient",
      gradient: {
        type: "linear",
        from: { x: 0, y: 0.5 },
        to: { x: 1, y: 0.5 },
        stops: [
          { offset: 0, color: "#6366f1" },
          { offset: 1, color: "#a855f7" },
        ],
      },
    });
  });

  it("resolvePaint 对渐变 Token 返回 undefined（没有单一颜色）", () => {
    const store = storeWithGradientToken();
    expect(resolvePaint(store.doc, { token: "gradient/brand" })).toBeUndefined();
  });

  it("缺失 Token 或把数值 Token 填进填充：洋红示警", () => {
    const store = storeWithGradientToken();
    store.doc.tokens["size/md"] = { type: "number", value: 16 };
    expect(resolvePaintSpec(store.doc, { token: "gradient/missing" })).toEqual({ type: "solid", color: "#ff00ff" });
    expect(resolvePaintSpec(store.doc, { token: "size/md" })).toEqual({ type: "solid", color: "#ff00ff" });
    expect(resolvePaint(store.doc, { token: "size/md" })).toBe("#ff00ff");
  });

  it("Token 值被手改成脏数据时按缺失处理", () => {
    const store = storeWithGradientToken();
    store.doc.tokens["gradient/bad"] = { type: "gradient", value: "not a gradient" as never };
    expect(resolvePaintSpec(store.doc, { token: "gradient/bad" })).toEqual({ type: "solid", color: "#ff00ff" });
  });

  it("resolveGradient 少于 2 个可解析色标时返回 undefined", () => {
    const store = storeWithGradientToken();
    const sparse: GradientValue = {
      ...linear,
      stops: [{ offset: 0, color: { token: "color/a" } }],
    };
    expect(resolveGradient(store.doc, sparse)).toBeUndefined();
  });
});

describe("渐变 Token：引用随动", () => {
  it("重命名颜色 Token 时，渐变 Token 里的色标一起改", () => {
    const store = storeWithGradientToken();
    store.apply({ type: "token.rename", params: { from: "color/a", to: "color/brand" } });
    const value = store.doc.tokens["gradient/brand"]?.value as GradientValue;
    expect(value.stops[0]?.color.token).toBe("color/brand");
    expect(value.stops[1]?.color.token).toBe("color/b");
  });

  it("删除被节点引用的渐变 Token：先冻结成渐变字面量，再删", () => {
    const store = storeWithGradientToken();
    const node = rectFilledWith(store, { token: "gradient/brand" });

    const blocked = planTokenDelete(store.doc, "gradient/brand", false);
    expect(blocked.status).toBe("blocked");

    const plan = planTokenDelete(store.doc, "gradient/brand", true);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    // 删除确认里展示的是可读描述，不是 [object Object]
    expect(plan.value).toBe("linear (2 stops)");

    store.transact("delete", () => {
      for (const cmd of plan.commands) store.apply(cmd);
    });
    expect(store.doc.tokens["gradient/brand"]).toBeUndefined();
    const fill = store.doc.nodes[node.id]!.style.fill;
    expect(isGradientValue(fill)).toBe(true);
    // 冻结后视觉不变：色标仍指向原来的颜色 Token
    expect(resolvePaintSpec(store.doc, fill)).toMatchObject({ type: "gradient" });
  });

  it("删除被渐变 Token 引用的颜色 Token：色标冻结成字面量", () => {
    const store = storeWithGradientToken();
    const plan = planTokenDelete(store.doc, "color/a", true);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    // 没有节点引用，但删之前必须让调用方知道改了哪个渐变 Token
    expect(plan.refs).toEqual([]);
    expect(plan.tokenRefs).toEqual(["gradient/brand"]);
    if (plan.status !== "ready") return;
    store.transact("delete", () => {
      for (const cmd of plan.commands) store.apply(cmd);
    });
    const value = store.doc.tokens["gradient/brand"]?.value as GradientValue;
    expect(value.stops[0]?.color).toEqual({ value: "#6366f1" });
  });
});

describe("渐变 Token：诊断", () => {
  it("数值 Token 填进填充报 TOKEN_TYPE", () => {
    const store = storeWithGradientToken();
    store.doc.tokens["size/md"] = { type: "number", value: 16 };
    const pageId = store.doc.rootIds[0]!;
    rectFilledWith(store, { token: "size/md" });
    const codes = diagnose(store.doc, [pageId]).diagnostics.map((d) => d.code);
    expect(codes).toContain("TOKEN_TYPE");
  });

  it("渐变 Token 用在字号字段报 TOKEN_TYPE", () => {
    const store = storeWithGradientToken();
    const pageId = store.doc.rootIds[0]!;
    const text = createNode("text", { name: "T", style: { fontSizeToken: "gradient/brand" } });
    store.apply({ type: "node.create", params: { nodes: [text], parentId: pageId } });
    const diagnostics = diagnose(store.doc, [pageId]).diagnostics.filter((d) => d.code === "TOKEN_TYPE");
    expect(diagnostics.map((d) => d.nodeId)).toContain(text.id);
  });
});

describe("渐变 Token：格式版本", () => {
  it("10 → 11 不需要改数据", () => {
    const state: DocState = createDocWithPage();
    state.formatVersion = 10;
    state.tokens["color/a"] = { type: "color", value: "#000000" };
    const migrated = migrateDoc(state, 10);
    expect(migrated.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(CURRENT_FORMAT_VERSION).toBe(11);
    expect(migrated.tokens["color/a"]).toEqual({ type: "color", value: "#000000" });
  });
});
