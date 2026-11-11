import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, newId, type DocNode, type DocState, type Interaction } from "../src/model";
import { DocStore } from "../src/store";
import { materializeInstance } from "../src/component";
import { planDuplicate, remapNode } from "../src/duplicate";
import { CURRENT_FORMAT_VERSION } from "../src/migrate";
import { migrateDoc } from "../src/migrate";
import { DEFAULT_DISSOLVE_MS, MAX_INTERACTIONS } from "../src/interaction";

function link(targetId: string, type: "instant" | "dissolve" = "dissolve", durationMs = DEFAULT_DISSOLVE_MS): Interaction {
  return { id: newId(), trigger: "click", action: "navigate", targetId, transition: { type, durationMs } };
}

/** 文档：页面 A + 页面 B；A 里有一个矩形。 */
function twoPages(): { store: DocStore; a: string; b: string; rect: DocNode } {
  const store = new DocStore(createDocWithPage("A"));
  const a = store.doc.rootIds[0];
  const b = createNode("page", { name: "B", x: 2000, y: 0 });
  store.apply({ type: "node.create", params: { nodes: [b], parentId: null } });
  const rect = createNode("rect", { name: "按钮", width: 80, height: 32 });
  store.apply({ type: "node.create", params: { nodes: [rect], parentId: a } });
  return { store, a, b: b.id, rect };
}

describe("原型链接：写入与校验", () => {
  it("给页面里的图层挂链接，写入后原样读回", () => {
    const { store, b, rect } = twoPages();
    const one = link(b);
    store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { interactions: [one] } } });
    expect(store.doc.nodes[rect.id].interactions).toEqual([one]);
  });

  it("instant 的时长归一化为 0，dissolve 夹到 60–2000", () => {
    const { store, b, rect } = twoPages();
    store.apply({
      type: "node.update",
      params: { nodeId: rect.id, patch: { interactions: [link(b, "instant", 900)] } },
    });
    expect(store.doc.nodes[rect.id].interactions?.[0].transition).toEqual({ type: "instant", durationMs: 0 });

    store.apply({
      type: "node.update",
      params: { nodeId: rect.id, patch: { interactions: [link(b, "dissolve", 99999)] } },
    });
    expect(store.doc.nodes[rect.id].interactions?.[0].transition.durationMs).toBe(2000);
  });

  it("空数组表示清空", () => {
    const { store, b, rect } = twoPages();
    store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { interactions: [link(b)] } } });
    store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { interactions: [] } } });
    expect(store.doc.nodes[rect.id].interactions).toBeUndefined();
  });

  it("目标不存在 / 不是页面 / 指向自己所在页面 都拒绝", () => {
    const { store, a, rect } = twoPages();
    expect(() =>
      store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { interactions: [link("nope")] } } }),
    ).toThrow(/不存在/);
    expect(() =>
      store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { interactions: [link(rect.id)] } } }),
    ).toThrow(/页面/);
    expect(() =>
      store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { interactions: [link(a)] } } }),
    ).toThrow(/自己所在/);
  });

  it("页面自己不能持有链接", () => {
    const { store, b, a } = twoPages();
    expect(() =>
      store.apply({ type: "node.update", params: { nodeId: a, patch: { interactions: [link(b)] } } }),
    ).toThrow(/页面是链接的目标/);
  });

  it("主组件与实例子孙不能持有链接，实例根可以", () => {
    const { store, a, b } = twoPages();
    const frame = createNode("frame", { name: "卡片", width: 100, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: a } });
    const label = createNode("text", { parentId: frame.id, text: "按钮", width: 40, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [label], parentId: frame.id } });
    store.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
    const componentId = frame.id;
    expect(store.doc.nodes[componentId].type).toBe("component");

    expect(() =>
      store.apply({ type: "node.update", params: { nodeId: componentId, patch: { interactions: [link(b)] } } }),
    ).toThrow(/页面/);

    const instanceId = newId();
    store.apply({
      type: "instance.create",
      params: { componentId, parentId: a, nodeId: instanceId, x: 0, y: 0 },
    });
    // 实例根可以挂
    store.apply({ type: "node.update", params: { nodeId: instanceId, patch: { interactions: [link(b)] } } });
    expect(store.doc.nodes[instanceId].interactions).toHaveLength(1);

    // 实例内部的一级子节点不行
    const inner = store.doc.nodes[instanceId].children[0];
    expect(() =>
      store.apply({ type: "node.update", params: { nodeId: inner, patch: { interactions: [link(b)] } } }),
    ).toThrow(/实例内部/);
  });

  it("条数上限与重复 id", () => {
    const { store, b, rect } = twoPages();
    const many = Array.from({ length: MAX_INTERACTIONS + 1 }, () => link(b));
    expect(() =>
      store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { interactions: many } } }),
    ).toThrow(/最多/);

    const dup = link(b);
    expect(() =>
      store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { interactions: [dup, { ...dup }] } } }),
    ).toThrow(/重复/);
  });

  it("back 动作不带目标也能写入，转场收敛为 instant", () => {
    const { store, rect } = twoPages();
    store.apply({
      type: "node.update",
      params: {
        nodeId: rect.id,
        patch: { interactions: [{ id: newId(), trigger: "click", action: "back", transition: { type: "dissolve", durationMs: 900 } }] },
      },
    });
    expect(store.doc.nodes[rect.id].interactions?.[0]).toMatchObject({
      action: "back",
      transition: { type: "instant", durationMs: 0 },
    });
  });

  it("滚动方向只接受页面上的三个值", () => {
    const { store, a, rect } = twoPages();
    store.apply({ type: "node.update", params: { nodeId: a, patch: { scrollDirection: "vertical" } } });
    expect(store.doc.nodes[a].scrollDirection).toBe("vertical");
    expect(() =>
      store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { scrollDirection: "vertical" } } }),
    ).toThrow(/页面/);
    expect(() =>
      store.apply({
        type: "node.update",
        params: { nodeId: a, patch: { scrollDirection: "diagonal" as unknown as "vertical" } },
      }),
    ).toThrow(/滚动方向/);
  });
});

describe("原型链接：引用完整性", () => {
  it("删除目标页面会清掉指向它的链接，撤销后原样还原", () => {
    const { store, b, rect } = twoPages();
    const one = link(b);
    store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { interactions: [one] } } });

    store.apply({ type: "node.delete", params: { nodeId: b } });
    expect(store.doc.nodes[rect.id].interactions).toBeUndefined();

    store.undo();
    expect(store.doc.nodes[rect.id].interactions).toEqual([one]);
    expect(store.doc.nodes[b]).toBeTruthy();
  });

  it("转组件时清掉子树里的链接", () => {
    const { store, a, b } = twoPages();
    const frame = createNode("frame", { name: "卡片", width: 100, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: a } });
    const inner = createNode("rect", { width: 10, height: 10 });
    store.apply({ type: "node.create", params: { nodes: [inner], parentId: frame.id } });
    store.apply({
      type: "node.update",
      params: { nodeId: frame.id, patch: { interactions: [link(b)] } },
    });
    store.apply({
      type: "node.update",
      params: { nodeId: inner.id, patch: { interactions: [link(b)] } },
    });

    store.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
    expect(store.doc.nodes[frame.id].interactions).toBeUndefined();
    expect(store.doc.nodes[inner.id].interactions).toBeUndefined();
  });

  it("复制含链接的页面不会因为位置校验失败，链接跟着副本走", () => {
    const { store, a, b, rect } = twoPages();
    store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { interactions: [link(b)] } } });

    const plan = planDuplicate(store.doc, [a], { makeId: () => newId() });
    expect(() => store.apply(plan.command, "dup-page")).not.toThrow();

    const copy = store.doc.nodes[plan.rootIds[0]];
    expect(copy.type).toBe("page");
    const copiedChild = copy.children.map((id) => store.doc.nodes[id]).find((n) => n.type === "rect");
    expect(copiedChild?.interactions?.[0].targetId).toBe(b);
  });

  it("整页粘贴（node.create 一批里自带页面）时链接跟着走", () => {
    const { store, b } = twoPages();
    const page = createNode("page", { name: "Pasted", width: 100, height: 100 });
    const child = createNode("rect", { parentId: page.id, width: 10, height: 10, interactions: [link(b)] });
    page.children = [child.id];
    expect(() =>
      store.apply({ type: "node.create", params: { nodes: [page, child], parentId: null } }),
    ).not.toThrow();
  });

  it("创建时就指向自己所在页面的链接被拒绝", () => {
    const { store, a } = twoPages();
    const node = createNode("rect", { width: 10, height: 10, interactions: [link(a)] });
    expect(() => store.apply({ type: "node.create", params: { nodes: [node], parentId: a } })).toThrow(/自己所在/);
  });

  it("实例物化不复制母版上的链接", () => {
    const doc: DocState = createDocWithPage("A");
    const pageId = doc.rootIds[0];
    const component = createNode("component", { name: "C", parentId: null, width: 100, height: 100 });
    const masterChild = createNode("rect", { parentId: component.id, width: 10, height: 10, interactions: [link(pageId)] });
    component.children = [masterChild.id];
    doc.nodes[component.id] = component;
    doc.nodes[masterChild.id] = masterChild;
    doc.rootIds.push(component.id);

    const nodes = materializeInstance(doc, component.id, "inst_1", pageId, 0, 0);
    expect(nodes[0].interactions).toBeUndefined();
    for (const node of nodes.slice(1)) expect(node.interactions).toBeUndefined();
  });
});

describe("原型链接：复制与粘贴", () => {
  it("同文档复制保留指向原页面的链接", () => {
    const { store, b, rect } = twoPages();
    const one = link(b);
    store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { interactions: [one] } } });
    store.apply({
      type: "node.duplicate",
      params: { nodeIds: [rect.id], dx: 20, dy: 0, idMap: { [rect.id]: "copy_1" } },
    });
    expect(store.doc.nodes["copy_1"].interactions).toEqual([one]);
  });

  it("跨文档粘贴丢弃指向外部页面的链接", () => {
    const src = createNode("rect", { width: 10, height: 10, interactions: [link("page_x")] });
    const kept = remapNode(src, { [src.id]: "new_1" });
    expect(kept.interactions?.[0].targetId).toBe("page_x");

    const dropped = remapNode(src, { [src.id]: "new_2" }, { externalLinkTargets: "drop" });
    expect(dropped.interactions).toBeUndefined();
  });
});

describe("文件格式", () => {
  it("7 → 8 迁移只提升版本号", () => {
    const doc = createDocWithPage("A");
    doc.formatVersion = 7;
    migrateDoc(doc, 7);
    expect(doc.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(CURRENT_FORMAT_VERSION).toBe(8);
  });
});
