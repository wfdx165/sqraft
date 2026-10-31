import { describe, expect, it } from "vitest";
import { createDocWithPage, createNode } from "../src/model";
import { DocStore } from "../src/store";

/**
 * `snapshot()` 只服务于保存。它曾经用 `structuredClone`：文档里一旦混进
 * Vue reactive 代理（UI 层把 `ref(...).value` 直接塞进命令参数），
 * `structuredClone` 会抛 `DataCloneError`，而保存链路没有 try/catch，
 * 结果就是"点保存没反应 + 关不掉窗口"。
 */
describe("文档快照", () => {
  function storeWithRect(): { store: DocStore; nodeId: string } {
    const store = new DocStore(createDocWithPage());
    const pageId = store.doc.rootIds[0];
    const rect = createNode("rect", { parentId: pageId, x: 0, y: 0, width: 10, height: 10 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    return { store, nodeId: rect.id };
  }

  it("文档里混进代理也能快照（保存不因 UI 层失误失败）", () => {
    const { store, nodeId } = storeWithRect();
    // 模拟 reactive / ref 的代理对象
    (store.doc.nodes[nodeId] as unknown as { style: unknown }).style = new Proxy(
      { fill: { value: "#ff0000" } },
      {},
    );

    expect(() => store.snapshot()).not.toThrow();
    expect(store.snapshot().nodes[nodeId].style.fill).toEqual({ value: "#ff0000" });
  });

  it("快照是副本：改快照不影响文档", () => {
    const { store, nodeId } = storeWithRect();
    const snapshot = store.snapshot();
    snapshot.nodes[nodeId].width = 999;
    expect(store.doc.nodes[nodeId].width).toBe(10);
  });

  it("循环引用会抛出可读错误（由调用方弹窗，而不是静默失败）", () => {
    const { store, nodeId } = storeWithRect();
    (store.doc.nodes[nodeId] as unknown as { self: unknown }).self = store.doc.nodes[nodeId];
    expect(() => store.snapshot()).toThrow();
  });
});
