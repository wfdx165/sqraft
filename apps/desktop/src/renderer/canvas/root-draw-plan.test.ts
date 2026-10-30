import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode, DocStore, type NodeId } from "@sqraft/core";
import { rootDrawPlan } from "@sqraft/render";

/** 页面 1440×1024 + 一个压在页面上的根级母版。 */
function setup(): { doc: DocStore; pageId: NodeId; masterId: NodeId } {
  const store = new DocStore(createDocWithPage());
  const pageId = store.doc.rootIds[0];
  const frame = createNode("frame", { name: "卡片", x: 40, y: 40, width: 200, height: 100 });
  store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
  store.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
  return { doc: store, pageId, masterId: frame.id };
}

describe("根节点绘制清单", () => {
  it("画布渲染：页面 + 母版都要画", () => {
    const { doc, pageId, masterId } = setup();
    const plan = rootDrawPlan(doc.doc);
    expect(plan.pages.map((p) => p.id)).toEqual([pageId]);
    expect(plan.components.map((c) => c.id)).toEqual([masterId]);
  });

  it("页面导出：只画该页，母版即使压在页面上也不画", () => {
    const { doc, pageId } = setup();
    const plan = rootDrawPlan(doc.doc, [pageId]);
    expect(plan.pages.map((p) => p.id)).toEqual([pageId]);
    expect(plan.components).toEqual([]);
  });

  it("多页文档导出某页时其它页不参与", () => {
    const { doc, pageId } = setup();
    const second = createNode("page", { name: "页面 2", x: 2000, width: 800, height: 600 });
    doc.apply({ type: "node.create", params: { nodes: [second], parentId: null } });
    const plan = rootDrawPlan(doc.doc, [second.id]);
    expect(plan.pages.map((p) => p.id)).toEqual([second.id]);
    expect(plan.pages.map((p) => p.id)).not.toContain(pageId);
  });
});
