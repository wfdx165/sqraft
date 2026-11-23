import { describe, expect, it } from "vitest";
import {
  CURRENT_FORMAT_VERSION,
  DocStore,
  createDocWithPage,
  createNode,
  firstPageId,
  getPageGroups,
  getPagesInGroup,
  getVisiblePages,
  isPageLockedByGroup,
  isPageVisibleByGroup,
  migrateDoc,
  newGroupId,
  nextPagePositionInGroup,
  type DocState,
} from "../src/index";

describe("PageGroup 模型与命令", () => {
  it("创建、归组、更新、排序、解散与完整撤销/重做", () => {
    const store = new DocStore(createDocWithPage("首页"));
    const p1 = firstPageId(store.doc)!;
    const p2 = createNode("page", { name: "详情页", x: 1600, y: 0, width: 1440, height: 1024 });
    store.apply({ type: "node.create", params: { nodes: [p2], parentId: null } });

    const g1 = newGroupId();
    store.apply({
      type: "pageGroup.create",
      params: { group: { id: g1, name: "v1.0.0", color: "#6366f1" }, pageIds: [p1] },
    });
    expect(getPageGroups(store.doc).map((g) => g.name)).toEqual(["v1.0.0"]);
    expect(getPagesInGroup(store.doc, g1).map((p) => p.id)).toEqual([p1]);
    expect(getPagesInGroup(store.doc, null).map((p) => p.id)).toEqual([p2.id]);

    // 建第二个分组并排序
    const g2 = newGroupId();
    store.apply({ type: "pageGroup.create", params: { group: { id: g2, name: "iPad" } } });
    store.apply({ type: "pageGroup.reorder", params: { groupId: g2, index: 0 } });
    expect(getPageGroups(store.doc).map((g) => g.id)).toEqual([g2, g1]);

    // 归组 p2 到 g2
    store.apply({ type: "pageGroup.assignPages", params: { pageIds: [p2.id], groupId: g2 } });
    expect(store.doc.nodes[p2.id].groupId).toBe(g2);

    // 撤销归组与排序
    store.undo();
    expect(store.doc.nodes[p2.id].groupId).toBeUndefined();
    store.undo();
    expect(getPageGroups(store.doc).map((g) => g.id)).toEqual([g1, g2]);

    // 解散分组 g1 保留页面，再撤销恢复
    store.apply({ type: "pageGroup.delete", params: { groupId: g1, mode: "ungroup" } });
    expect(getPageGroups(store.doc).map((g) => g.id)).toEqual([g2]);
    expect(store.doc.nodes[p1].groupId).toBeUndefined();
    store.undo();
    expect(getPageGroups(store.doc).map((g) => g.id)).toEqual([g1, g2]);
    expect(store.doc.nodes[p1].groupId).toBe(g1);
  });

  it("锁定分组拦截组内页面与子节点的修改与删组，解锁后恢复可编辑", () => {
    const store = new DocStore(createDocWithPage("归档页"));
    const p1 = firstPageId(store.doc)!;
    const rect = createNode("rect", { name: "卡片", x: 10, y: 10, width: 100, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: p1 } });

    const g1 = newGroupId();
    store.apply({
      type: "pageGroup.create",
      params: { group: { id: g1, name: "v1.0.0", locked: true }, pageIds: [p1] },
    });

    expect(isPageLockedByGroup(store.doc, store.doc.nodes[p1])).toBe(true);
    expect(() =>
      store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { x: 50 } } }),
    ).toThrow(/锁定/);
    expect(() =>
      store.apply({ type: "node.delete", params: { nodeId: rect.id } }),
    ).toThrow(/锁定/);
    expect(() =>
      store.apply({ type: "pageGroup.delete", params: { groupId: g1, mode: "ungroup" } }),
    ).toThrow(/锁定/);

    // 解锁后可正常编辑
    store.apply({ type: "pageGroup.update", params: { groupId: g1, patch: { locked: false } } });
    expect(isPageLockedByGroup(store.doc, store.doc.nodes[p1])).toBe(false);
    store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { x: 50 } } });
    expect(store.doc.nodes[rect.id].x).toBe(50);
  });

  it("隐藏分组过滤可见页面，且 deletePages 会一并清理原型入站链接", () => {
    const store = new DocStore(createDocWithPage("主流程"));
    const p1 = firstPageId(store.doc)!;
    const p2 = createNode("page", { name: "旧版页", x: 1600, y: 0, width: 1440, height: 1024 });
    const btn = createNode("rect", { name: "按钮", x: 20, y: 20, width: 100, height: 40 });
    store.apply([
      { type: "node.create", params: { nodes: [p2], parentId: null } },
      { type: "node.create", params: { nodes: [btn], parentId: p1 } },
      {
        type: "node.update",
        params: {
          nodeId: btn.id,
          patch: {
            interactions: [
              { id: "i1", trigger: "click", action: "navigate", targetId: p2.id, transition: { type: "instant", durationMs: 0 } },
            ],
          },
        },
      },
    ]);

    const g1 = newGroupId();
    store.apply({
      type: "pageGroup.create",
      params: { group: { id: g1, name: "v0.9", visible: false }, pageIds: [p2.id] },
    });
    expect(isPageVisibleByGroup(store.doc, store.doc.nodes[p2.id])).toBe(false);
    expect(getVisiblePages(store.doc).map((p) => p.id)).toEqual([p1]);

    // 删除分组及页面：入站链接一并清理，撤销后全部恢复
    store.apply({ type: "pageGroup.delete", params: { groupId: g1, mode: "deletePages" } });
    expect(store.doc.nodes[p2.id]).toBeUndefined();
    expect(store.doc.nodes[btn.id].interactions ?? []).toHaveLength(0);

    store.undo();
    expect(store.doc.nodes[p2.id]).toBeDefined();
    expect(store.doc.nodes[btn.id].interactions).toHaveLength(1);
  });

  it("nextPagePositionInGroup 排在该组最右页面之右，且 migrateDoc v11 → v12 补齐 pageGroups", () => {
    const store = new DocStore(createDocWithPage("P1"));
    const p1 = firstPageId(store.doc)!;
    const g1 = newGroupId();
    store.apply({
      type: "pageGroup.create",
      params: { group: { id: g1, name: "iPad", defaultPageSize: { width: 1024, height: 1366 } }, pageIds: [p1] },
    });
    const pos = nextPagePositionInGroup(store.doc, g1);
    expect(pos.x).toBe(1440 + 160);
    expect(pos.y).toBe(0);

    const legacy = { version: 1, formatVersion: 11, rootIds: [], nodes: {}, tokens: {} } as DocState;
    const migrated = migrateDoc(legacy, 11);
    expect(migrated.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(migrated.pageGroups).toEqual([]);
  });
});
