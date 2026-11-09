import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, newId, resolvePaint, type NodeId } from "../src/model";
import { DocStore, type Command } from "../src/store";
import { hasTokenRef, mapTokenPaints, planTokenDelete, tokenRefsOf } from "../src/token-refs";

/** 只取"冻结引用"那几条命令（不含最后一条 token.delete）：生产路径走 planTokenDelete。 */
function detachCommands(store: DocStore, path: string): Command[] {
  const plan = planTokenDelete(store.doc, path, true);
  if (plan.status !== "ready") return [];
  return plan.commands.filter((cmd) => cmd.type !== "token.delete");
}

function storeWithRefs() {
  const store = new DocStore(createDocWithPage());
  store.doc.tokens["color/primary"] = { type: "color", value: "#3366ff" };
  store.doc.tokens["color/muted"] = { type: "color", value: "#808080" };
  const pageId = store.doc.rootIds[0];

  const bound = createNode("rect", {
    name: "R",
    style: {
      fill: { token: "color/primary" },
      stroke: { token: "color/primary" },
      effects: [
        {
          type: "drop-shadow",
          visible: true,
          x: 0,
          y: 4,
          blur: 8,
          spread: 0,
          color: { token: "color/primary" },
        },
      ],
    },
  });
  const other = createNode("rect", { name: "O", style: { fill: { token: "color/muted" } } });
  const plain = createNode("rect", { name: "P", style: { fill: { value: "#ff0000" } } });
  store.apply({ type: "node.create", params: { nodes: [bound, other, plain], parentId: pageId } });

  return { store, bound, other, plain };
}

describe("Token 引用查询", () => {
  it("命中填充、描边与阴影颜色，按节点去重", () => {
    const { store, bound } = storeWithRefs();
    expect(tokenRefsOf(store.doc, "color/primary")).toEqual([bound.id]);
    expect(tokenRefsOf(store.doc, "color/muted")).toHaveLength(1);
    expect(tokenRefsOf(store.doc, "color/absent")).toEqual([]);
  });

  it("字面量样式不算引用", () => {
    const { store, plain } = storeWithRefs();
    expect(hasTokenRef(store.doc.nodes[plain.id].style, "color/primary")).toBe(false);
  });

  it("没命中时 mapTokenPaints 返回 null（调用方据此跳过写回）", () => {
    const { store, other } = storeWithRefs();
    expect(mapTokenPaints(store.doc.nodes[other.id].style, "color/primary", () => ({ value: "#000" }))).toBeNull();
  });
});

describe("删除 Token 前冻结引用", () => {
  it("冻结成当前取值的字面量，渲染结果不变", () => {
    const { store, bound } = storeWithRefs();
    const before = resolvePaint(store.doc, store.doc.nodes[bound.id].style.fill);

    for (const cmd of detachCommands(store, "color/primary")) store.apply(cmd);

    const style = store.doc.nodes[bound.id].style;
    expect(style.fill).toEqual({ value: "#3366ff" });
    expect(style.stroke).toEqual({ value: "#3366ff" });
    expect(style.effects?.[0]).toMatchObject({ color: { value: "#3366ff" } });
    expect(resolvePaint(store.doc, style.fill)).toBe(before);
    // Token 本身此时还在：删除由调用方在同一条事务里补
    expect(store.doc.tokens["color/primary"]).toEqual({ type: "color", value: "#3366ff" });
  });

  it("不碰没引用它的节点", () => {
    const { store, other, plain } = storeWithRefs();
    const otherStyle = store.doc.nodes[other.id].style;
    const plainStyle = store.doc.nodes[plain.id].style;

    for (const cmd of detachCommands(store, "color/primary")) store.apply(cmd);

    expect(store.doc.nodes[other.id].style).toBe(otherStyle);
    expect(store.doc.nodes[plain.id].style).toBe(plainStyle);
  });

  it("冻结 + 删除包成一条撤销，撤销后引用与 Token 一起回来", async () => {
    const { store, bound } = storeWithRefs();

    const plan = planTokenDelete(store.doc, "color/primary", true);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    await store.transact("删除 Token", () => {
      for (const cmd of plan.commands) store.apply(cmd);
    });

    expect(store.doc.tokens["color/primary"]).toBeUndefined();
    expect(store.doc.nodes[bound.id].style.fill).toEqual({ value: "#3366ff" });
    expect(resolvePaint(store.doc, store.doc.nodes[bound.id].style.fill)).toBe("#3366ff");

    store.undo();
    expect(store.doc.tokens["color/primary"]).toEqual({ type: "color", value: "#3366ff" });
    expect(store.doc.nodes[bound.id].style.fill).toEqual({ token: "color/primary" });
    expect(store.doc.nodes[bound.id].style.effects?.[0]).toMatchObject({ color: { token: "color/primary" } });
  });
});

describe("实例覆盖里的引用", () => {
  it("克隆节点是真实节点，覆盖里的引用能被扫描到并冻结干净", async () => {
    const store = new DocStore(createDocWithPage());
    store.doc.tokens["color/a"] = { type: "color", value: "#111111" };
    store.doc.tokens["color/b"] = { type: "color", value: "#222222" };
    const pageId = store.doc.rootIds[0];

    // 主组件 + 引用 color/a 的子节点
    const component = createNode("component", { name: "Card", x: 2000, y: 0 });
    const masterChild = createNode("rect", { parentId: component.id, style: { fill: { token: "color/a" } } });
    component.children.push(masterChild.id);
    store.apply({ type: "node.create", params: { nodes: [component, masterChild], parentId: null } });

    const instanceId = newId();
    store.apply({
      type: "instance.create",
      params: { componentId: component.id, parentId: pageId, nodeId: instanceId, x: 200, y: 0 },
    });
    const clone = Object.values(store.doc.nodes).find((node) => node.id.startsWith(`${instanceId}:`))!;

    // 只改实例里的克隆：引用会落到 instance.overrides 上
    store.apply({
      type: "node.update",
      params: { nodeId: clone.id, patch: { style: { ...clone.style, fill: { token: "color/b" } } } },
    });
    expect(JSON.stringify(store.doc.nodes[instanceId].overrides)).toContain("color/b");

    expect(tokenRefsOf(store.doc, "color/b")).toEqual([clone.id]);

    const plan = planTokenDelete(store.doc, "color/b", true);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    await store.transact("删除 Token", () => {
      for (const cmd of plan.commands) store.apply(cmd);
    });

    // 视觉不变，且节点（含覆盖表）里不再残留旧路径
    expect(resolvePaint(store.doc, store.doc.nodes[clone.id].style.fill)).toBe("#222222");
    expect(JSON.stringify(store.doc.nodes[instanceId].overrides ?? {})).not.toContain("color/b");
    expect(JSON.stringify(store.doc.nodes)).not.toContain("color/b");
  });
});

describe("改名同步实例覆盖", () => {
  /** 组件（子节点 fill=color/a）+ N 个实例，每个实例把克隆的 fill 覆盖成 color/b。 */
  function withInstances(count: number) {
    const store = new DocStore(createDocWithPage());
    store.doc.tokens["color/a"] = { type: "color", value: "#111111" };
    store.doc.tokens["color/b"] = { type: "color", value: "#222222" };
    const pageId = store.doc.rootIds[0];

    const component = createNode("component", { name: "Card", x: 2000, y: 0 });
    const masterChild = createNode("rect", { parentId: component.id, style: { fill: { token: "color/a" } } });
    component.children.push(masterChild.id);
    store.apply({ type: "node.create", params: { nodes: [component, masterChild], parentId: null } });

    const cloneIds: NodeId[] = [];
    for (let i = 0; i < count; i += 1) {
      const instanceId = newId();
      store.apply({
        type: "instance.create",
        params: { componentId: component.id, parentId: pageId, nodeId: instanceId, x: 200 + i * 100, y: 0 },
      });
      const clone = Object.values(store.doc.nodes).find((node) => node.id.startsWith(`${instanceId}:`))!;
      store.apply({
        type: "node.update",
        params: { nodeId: clone.id, patch: { style: { ...clone.style, fill: { token: "color/b" } } } },
      });
      cloneIds.push(clone.id);
    }

    return { store, masterChild, cloneIds };
  }

  it("改名同时改写母版、克隆节点与实例覆盖表", () => {
    const { store, masterChild, cloneIds } = withInstances(2);
    const overrideOf = (cloneId: string) => {
      const instance = store.doc.nodes[cloneId.split(":")[0]];
      return instance.overrides?.[masterChild.id]?.style?.fill;
    };

    for (const cloneId of cloneIds) expect(overrideOf(cloneId)).toEqual({ token: "color/b" });

    store.apply({ type: "token.rename", params: { from: "color/b", to: "color/c" } });

    // 母版没引用过 color/b，不该被改
    expect(store.doc.nodes[masterChild.id].style.fill).toEqual({ token: "color/a" });
    for (const cloneId of cloneIds) {
      expect(store.doc.nodes[cloneId].style.fill).toEqual({ token: "color/c" });
      expect(overrideOf(cloneId)).toEqual({ token: "color/c" });
    }
  });

  it("改名后再同步组件，克隆节点不会被覆盖表写回旧路径", () => {
    const { store, masterChild, cloneIds } = withInstances(1);
    store.apply({ type: "token.rename", params: { from: "color/b", to: "color/c" } });

    // 改母版其它字段，触发 planInstanceSync：它会把「母版 style + 覆盖」重算成克隆 style
    store.apply({ type: "node.update", params: { nodeId: masterChild.id, patch: { height: 120 } } });

    for (const cloneId of cloneIds) {
      expect(store.doc.nodes[cloneId].style.fill).toEqual({ token: "color/c" });
      // 旧路径若被写回，这里会是缺失 Token 的洋红告警色
      expect(resolvePaint(store.doc, store.doc.nodes[cloneId].style.fill)).toBe("#222222");
    }
  });

  it("撤销与重做把覆盖表一起改回去", () => {
    const { store, masterChild, cloneIds } = withInstances(1);
    const instanceId = cloneIds[0].split(":")[0];
    const overrideFill = () => store.doc.nodes[instanceId].overrides?.[masterChild.id]?.style?.fill;

    store.apply({ type: "token.rename", params: { from: "color/b", to: "color/c" } });
    expect(overrideFill()).toEqual({ token: "color/c" });

    store.undo();
    expect(overrideFill()).toEqual({ token: "color/b" });
    expect(store.doc.nodes[cloneIds[0]].style.fill).toEqual({ token: "color/b" });

    store.redo();
    expect(overrideFill()).toEqual({ token: "color/c" });
  });

  it("覆盖表没引用该 Token 时保持原对象（不做无意义的复制）", () => {
    const { store, cloneIds } = withInstances(1);
    const instanceId = cloneIds[0].split(":")[0];
    const before = store.doc.nodes[instanceId].overrides;

    store.apply({ type: "token.rename", params: { from: "color/a", to: "color/z" } });
    expect(store.doc.nodes[instanceId].overrides).toBe(before);
  });

  it("实例里再套实例：内层实例的覆盖表也会被同步", () => {
    const store = new DocStore(createDocWithPage());
    store.doc.tokens["color/a"] = { type: "color", value: "#111111" };
    store.doc.tokens["color/b"] = { type: "color", value: "#222222" };
    const pageId = store.doc.rootIds[0];

    // 组件 A：一个引用 color/a 的矩形
    const compA = createNode("component", { name: "A", x: 2000, y: 0 });
    const aChild = createNode("rect", { parentId: compA.id, style: { fill: { token: "color/a" } } });
    compA.children.push(aChild.id);
    store.apply({ type: "node.create", params: { nodes: [compA, aChild], parentId: null } });

    // 组件 B：里面放一个 A 的实例
    const compB = createNode("component", { name: "B", x: 2400, y: 0 });
    store.apply({ type: "node.create", params: { nodes: [compB], parentId: null } });
    store.apply({
      type: "instance.create",
      params: { componentId: compA.id, parentId: compB.id, nodeId: newId(), x: 0, y: 0 },
    });

    // 页面上放 B 的实例：nest 是内层实例克隆，inner 是最内层矩形
    const bInstanceId = newId();
    store.apply({
      type: "instance.create",
      params: { componentId: compB.id, parentId: pageId, nodeId: bInstanceId, x: 200, y: 0 },
    });
    const nested = Object.values(store.doc.nodes).find(
      (node) => node.type === "instance" && node.id.startsWith(`${bInstanceId}:`),
    )!;
    const inner = Object.values(store.doc.nodes).find(
      (node) => node.mainId === aChild.id && node.id.startsWith(`${bInstanceId}:`),
    )!;
    expect(Boolean(nested && inner)).toBe(true);

    // 覆盖最内层矩形的底色：差异记在内层实例的覆盖表上
    store.apply({
      type: "node.update",
      params: { nodeId: inner.id, patch: { style: { ...inner.style, fill: { token: "color/b" } } } },
    });
    expect(JSON.stringify(nested.overrides ?? {})).toContain("color/b");

    store.apply({ type: "token.rename", params: { from: "color/b", to: "color/c" } });

    expect(JSON.stringify(nested.overrides ?? {})).toContain("color/c");
    expect(store.doc.nodes[inner.id].style.fill).toEqual({ token: "color/c" });

    // 改一次组件 A 触发内层同步：不该被覆盖表写回旧路径
    store.apply({ type: "node.update", params: { nodeId: aChild.id, patch: { height: 130 } } });
    expect(resolvePaint(store.doc, store.doc.nodes[inner.id].style.fill)).toBe("#222222");
  });
});

describe("删除计划", () => {
  it("Token 不存在时返回 missing", () => {
    const { store } = storeWithRefs();
    expect(planTokenDelete(store.doc, "color/absent", true)).toEqual({ status: "missing" });
  });

  it("有引用且未要求 detach 时返回 blocked，且不提供可执行命令", () => {
    const { store } = storeWithRefs();
    const plan = planTokenDelete(store.doc, "color/primary", false);
    expect(plan.status).toBe("blocked");
    if (plan.status !== "blocked") return;
    expect(plan.refs).toHaveLength(1);
    expect(plan.value).toBe("#3366ff");
  });

  it("不能 detach 时也给出命令：冻结各引用节点，最后一条是 token.delete", () => {
    const { store } = storeWithRefs();
    store.doc.tokens["spacing/md"] = { type: "number", value: 12 };

    const referenced = planTokenDelete(store.doc, "color/primary", true);
    expect(referenced.status).toBe("ready");
    if (referenced.status !== "ready") return;
    // 1 个引用节点的 node.update + 1 条 token.delete
    expect(referenced.commands).toHaveLength(2);
    expect(referenced.commands.at(-1)).toEqual({ type: "token.delete", params: { path: "color/primary" } });

    const free = planTokenDelete(store.doc, "spacing/md", false);
    expect(free.status).toBe("ready");
    if (free.status !== "ready") return;
    expect(free.refs).toEqual([]);
    expect(free.commands).toEqual([{ type: "token.delete", params: { path: "spacing/md" } }]);
  });
});
