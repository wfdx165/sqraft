import { beforeEach, describe, expect, it } from "vitest";
import { computed } from "vue";
import { createEmptyDoc, createNode, firstPageId } from "@sqraft/core";
import { activateTab, docStore, hooks, ui } from "./store";
import { MAX_DOC_TABS, closeTab, createDocTab, docTabs, moveTab, resetSessions, sessionState } from "./sessions";

/** 用普通对象模拟画布视口：切标签时由 hooks 存取。 */
const view = { x: 0, y: 0, zoom: 1 };

hooks.getViewport = () => ({ x: view.x, y: view.y, width: 800, height: 600, zoom: view.zoom });
hooks.restoreViewport = ({ x, y, zoom }) => {
  view.x = x;
  view.y = y;
  view.zoom = zoom;
};
hooks.fitActivePage = () => {
  view.x = -200;
  view.y = -150;
  view.zoom = 1;
};
hooks.prepareTabSwitch = () => {};

function reset(): void {
  activateTab("home");
  resetSessions();
  view.x = 0;
  view.y = 0;
  view.zoom = 1;
}

/** 开一个带页面与矩形的标签，选中矩形，返回 { tabId, rectId, pageId }。 */
function openTab(offset: number) {
  const state = createEmptyDoc();
  const tab = createDocTab(state);
  activateTab(tab.id);
  const page = createNode("page", { name: "页面", x: offset, y: offset, width: 400, height: 300 });
  docStore.apply({ type: "node.create", params: { nodes: [page], parentId: null } });
  const pageId = firstPageId(docStore.doc)!;
  const rect = createNode("rect", { parentId: pageId, x: offset, y: offset, width: 20, height: 20 });
  docStore.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
  ui.activePageId = pageId;
  ui.expandedPageId = pageId;
  ui.selection = [rect.id];
  return { tabId: tab.id, rectId: rect.id, pageId };
}

describe("多标签会话", () => {
  beforeEach(reset);

  it("3 个标签各切 30 次：选区 / 撤销栈 / 视口都不串", () => {
    const a = openTab(0);
    view.x = 10;
    const b = openTab(100);
    view.x = 200;
    const c = openTab(200);
    view.x = 300;

    const expected = [
      { tab: a, x: 10 },
      { tab: b, x: 200 },
      { tab: c, x: 300 },
    ];

    for (let i = 0; i < 30; i += 1) {
      for (const entry of expected) {
        activateTab(entry.tab.tabId);
        expect(ui.selection).toEqual([entry.tab.rectId]);
        expect(ui.activePageId).toBe(entry.tab.pageId);
        // 撤销栈跟着标签走：三个标签各建了两条记录
        expect(docStore.canUndo).toBe(true);
        // 视口还原成离开时的位置
        expect(view.x).toBe(entry.x);
        // 离开前模拟一次滚动，下一次切回来应该记住它
        view.x = entry.x;
      }
    }
  });

  it("撤销只作用于活动标签", () => {
    const a = openTab(0);
    const b = openTab(100);

    activateTab(a.tabId);
    expect(docStore.undo()).toBe(true);
    expect(docStore.doc.nodes[a.rectId]).toBeUndefined();

    activateTab(b.tabId);
    expect(docStore.doc.nodes[b.rectId]).toBeDefined();
    expect(ui.selection).toEqual([b.rectId]);
  });

  it("首次激活走适配，之后用记住的视口", () => {
    const tab = createDocTab(createEmptyDoc());
    activateTab(tab.id);
    expect(view).toEqual({ x: -200, y: -150, zoom: 1 });

    view.x = 42;
    view.y = 43;
    view.zoom = 2;
    activateTab("home");
    activateTab(tab.id);
    expect(view).toEqual({ x: 42, y: 43, zoom: 2 });
  });

  it("Home 不可关，也不允许写文档", () => {
    const a = openTab(0);
    activateTab("home");
    expect(ui.docOpen).toBe(false);
    expect(() => docStore.apply({ type: "node.delete", params: { nodeId: a.rectId } })).toThrow(/Home/);
    expect(docTabs()).toHaveLength(1);
  });

  it("标签上限是 10 个文档（Home 不计）", () => {
    for (let i = 0; i < MAX_DOC_TABS; i += 1) createDocTab(createEmptyDoc());
    expect(docTabs()).toHaveLength(MAX_DOC_TABS);
    expect(sessionState.tabs).toHaveLength(MAX_DOC_TABS + 1);
  });

  it("关闭活动标签后激活右邻；关掉最后一个落回 Home 并重挂门面", () => {
    const a = openTab(0);
    const b = openTab(100);
    const c = openTab(200);

    activateTab(b.tabId);
    expect(closeTab(b.tabId)).toBe(c.tabId);
    activateTab(c.tabId);
    expect(sessionState.activeId).toBe(c.tabId);
    expect(ui.docOpen).toBe(true);

    // 关掉 c 之后剩 a：先落到 a，再关 a 才会回 Home
    expect(closeTab(c.tabId)).toBe(a.tabId);
    activateTab(a.tabId);
    expect(sessionState.activeId).toBe(a.tabId);
    expect(ui.docOpen).toBe(true);

    expect(closeTab(a.tabId)).toBe("home");
    activateTab("home");
    expect(ui.docOpen).toBe(false);
    expect(() => docStore.apply({ type: "node.delete", params: { nodeId: a.rectId } })).toThrow(/Home/);
  });

  it("门面订阅在切换后仍然只触发一次，并且看到的是新文档", () => {
    const a = openTab(0);
    const b = openTab(100);
    let calls = 0;
    let lastState = docStore.doc;
    const off = docStore.subscribe((state) => {
      calls += 1;
      lastState = state;
    });
    activateTab(a.tabId);
    expect(calls).toBe(1);
    expect(lastState).toBe(docStore.doc);
    expect(lastState.nodes[a.rectId]).toBeDefined();
    expect(lastState.nodes[b.rectId]).toBeUndefined();
    off();
  });

  it("标签列表对 computed 可见：增删与排序都会刷新（结构版本）", () => {
    // 回归：sessionState 是 shallowReactive，tabs 是普通数组，就地 push / splice
    // 不触发依赖——顶栏的 `computed(() => docTabs())` 会一直拿到第一次算的空列表。
    const ids = computed(() => docTabs().map((tab) => tab.id));
    expect(ids.value).toEqual([]);

    const a = createDocTab(createEmptyDoc());
    expect(ids.value).toEqual([a.id]);
    const b = createDocTab(createEmptyDoc());
    expect(ids.value).toEqual([a.id, b.id]);

    moveTab(b.id, a.id);
    expect(ids.value).toEqual([b.id, a.id]);

    closeTab(a.id);
    expect(ids.value).toEqual([b.id]);
  });

  it("未命名标签在创建时定编号：不重排、不回收", () => {
    const a = createDocTab(createEmptyDoc());
    const b = createDocTab(createEmptyDoc());
    const c = createDocTab(createEmptyDoc());
    expect([a, b, c].map((tab) => tab.file.untitledIndex)).toEqual([1, 2, 3]);

    closeTab(b.id);
    const d = createDocTab(createEmptyDoc());
    expect(d.file.untitledIndex).toBe(4);
  });

  it("有名字的标签不占编号", () => {
    const example = createDocTab(createEmptyDoc(), { name: "登录页" });
    expect(example.file.untitledIndex).toBeNull();
    const fresh = createDocTab(createEmptyDoc());
    expect(fresh.file.untitledIndex).toBe(1);
  });
});
