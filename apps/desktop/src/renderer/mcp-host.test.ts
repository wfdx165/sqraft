import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpCallRequest, McpCallResult } from "../shared/ipc";

/**
 * 一条 `tools/call` 在渲染层只能执行一次。
 *
 * 历史上 `installMcpHost()` 只在模块内保留 `installed` 守卫：dev 热更新换新模块实例后
 * 又注册一份 `onCall`，旧的还活着，于是同一条调用被两个宿主各跑一遍——
 * `create_node` 会落两个节点（返回 id 之外多一个没有子节点的副本）。
 */

const listeners = new Set<(request: McpCallRequest) => void>();
const responses: McpCallResult[] = [];

// mcp-host 在模块顶层读 window.sqraft（经 file-session），先装一个最小桥再动态导入
const bridge = {
  platform: "darwin",
  file: {
    open: vi.fn(),
    openPath: vi.fn(),
    save: vi.fn(async () => ({ status: "ok", mtimeMs: 1 })),
    saveAs: vi.fn(),
  },
  dialog: {
    unsaved: vi.fn(async () => "cancel"),
    overwrite: vi.fn(),
    error: vi.fn(async () => {}),
  },
  mcp: {
    onCall: (handler: (request: McpCallRequest) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    onStatus: () => () => {},
    setTools: vi.fn(),
    respond: (result: McpCallResult) => responses.push(result),
    status: async () => ({ listening: true, clients: [] }),
  },
  recent: { list: vi.fn(async () => []) },
  menu: { onCommand: () => () => {} },
  app: {
    info: vi.fn(),
    copyText: vi.fn(),
    signalReady: vi.fn(),
    onOpenRequest: () => () => {},
    onCloseRequest: () => () => {},
    setDirty: vi.fn(),
    finishClose: vi.fn(),
    cancelClose: vi.fn(),
  },
};

vi.stubGlobal("window", { sqraft: bridge });

function resetHostState(): void {
  listeners.clear();
  responses.length = 0;
  delete (globalThis as { __sqraftMcpHost?: unknown }).__sqraftMcpHost;
  delete (globalThis as { __sqraftMcpInflight?: unknown }).__sqraftMcpInflight;
}

/** 取当前唯一装上来的监听（每个用例都只该有一份）。 */
function onlyListener(): (request: McpCallRequest) => Promise<void> {
  expect(listeners.size).toBe(1);
  return [...listeners][0] as (request: McpCallRequest) => Promise<void>;
}

/** Home 上没有文档，文档类工具会被拒绝：每个跑工具的用例先开一个空文档标签，返回它的 tabId。 */
async function openDoc(): Promise<string> {
  const [{ createDocTab }, { activateTab }, { createEmptyDoc }] = await Promise.all([
    import("./sessions"),
    import("./store"),
    import("@sqraft/core"),
  ]);
  const tab = createDocTab(createEmptyDoc());
  activateTab(tab.id);
  return tab.id;
}

describe("MCP 宿主只执行一次", () => {
  beforeEach(() => {
    resetHostState();
    vi.resetModules();
  });

  it("HMR 重新执行模块后只保留一份监听", async () => {
    const first = await import("./mcp-host");
    first.installMcpHost();
    expect(listeners.size).toBe(1);

    // 模拟 dev 热更新：模块重新执行，旧实例还留着监听
    vi.resetModules();
    const second = await import("./mcp-host");
    second.installMcpHost();
    expect(listeners.size).toBe(1);
  });

  it("旧模块的 off 晚于新模块安装时，不会摘掉新监听", async () => {
    const first = await import("./mcp-host");
    first.installMcpHost();
    const oldHandle = (globalThis as { __sqraftMcpHost?: { off: () => void } }).__sqraftMcpHost!;
    expect(listeners.size).toBe(1);

    // 模拟 HMR：新模块实例装上自己的监听
    vi.resetModules();
    const second = await import("./mcp-host");
    second.installMcpHost();
    expect(listeners.size).toBe(1);

    // 旧实例的 dispose 迟到：只该摘掉它自己的那份
    oldHandle.off();
    expect(listeners.size).toBe(1);
    expect((globalThis as { __sqraftMcpHost?: unknown }).__sqraftMcpHost).toBeDefined();
  });

  it("同一条调用被投递两次只执行一次", async () => {
    const { installMcpHost } = await import("./mcp-host");
    const { docStore } = await import("./store");
    installMcpHost();
    const handle = onlyListener();
    const tabId = await openDoc();

    const request: McpCallRequest = { id: 7, name: "create_node", args: { kind: "rect", tabId } };
    await Promise.all([handle(request), handle(request)]);

    expect(responses).toHaveLength(1);
    expect(responses[0].ok).toBe(true);
    // 空文档会先建一页：页 + 矩形，不能是两个矩形
    expect(Object.keys(docStore.doc.nodes)).toHaveLength(2);
  });

  it("不同调用号各自执行", async () => {
    const { installMcpHost } = await import("./mcp-host");
    const { docStore } = await import("./store");
    installMcpHost();
    const handle = onlyListener();
    const tabId = await openDoc();

    await handle({ id: 1, name: "create_node", args: { kind: "rect", tabId } });
    await handle({ id: 2, name: "create_node", args: { kind: "ellipse", tabId } });

    expect(responses).toHaveLength(2);
    expect(responses.every((entry) => entry.ok)).toBe(true);
    expect(Object.keys(docStore.doc.nodes)).toHaveLength(3);
  });

  it("写工具留下活动痕迹，只读工具不留", async () => {
    const { installMcpHost, mcpUi } = await import("./mcp-host");
    const { agentActivity } = await import("./canvas/agent-activity");
    installMcpHost();
    const handle = onlyListener();
    const tabId = await openDoc();

    await handle({ id: 1, name: "read_document", args: { tabId } });
    expect(mcpUi.activity).toBeNull();
    expect(agentActivity.rects).toHaveLength(0);

    await handle({
      id: 2,
      name: "create_node",
      args: { kind: "rect", tabId },
      clientLabel: "c1 claude-code/2.1",
    });

    // 胶囊文案的来源：去掉会话序号，只留客户端身份与工具名
    expect(responses[1]?.error).toBeUndefined();
    expect(mcpUi.activity?.label).toBe("claude-code/2.1");
    expect(mcpUi.activity?.tool).toBe("create_node");
    expect(mcpUi.activity?.running).toBe(false);
    expect(mcpUi.activity?.pageId).not.toBeNull();
    // 描边目标是刚建的矩形（不是自动建的页）
    expect(agentActivity.rects).toHaveLength(1);
  });

  it("Home 上文档类工具明确报错，且不隐式新建文档", async () => {
    const { installMcpHost } = await import("./mcp-host");
    const { createDocTab, docTabs } = await import("./sessions");
    const { tabLabel } = await import("./tab-label");
    const { createEmptyDoc } = await import("@sqraft/core");
    installMcpHost();
    const handle = onlyListener();

    // 两个未命名标签都没有激活（activeId 仍是 Home），名字必须能分开
    const a = createDocTab(createEmptyDoc());
    const b = createDocTab(createEmptyDoc());

    await handle({ id: 1, name: "create_node", args: { kind: "rect" } });

    expect(responses[0]?.ok).toBe(false);
    const message = responses[0]?.error ?? "";
    expect(message).toContain("No document is open");
    expect(message).toContain(tabLabel(a));
    expect(message).toContain(tabLabel(b));
    expect(tabLabel(a)).not.toBe(tabLabel(b));
    expect(docTabs()).toHaveLength(2);
  });

  it("Home 上 app_state 仍可用，并列出活动标签", async () => {
    const { installMcpHost } = await import("./mcp-host");
    installMcpHost();
    const handle = onlyListener();

    await handle({ id: 1, name: "app_state", args: {} });

    expect(responses[0]?.ok).toBe(true);
    const state = JSON.parse(responses[0]!.value ?? "{}");
    expect(state.active.tabId).toBe("home");
    expect(state.tabs[0]).toMatchObject({ tabId: "home", home: true, active: true });
    expect(state.limit).toBe(10);
  });

  it("失败的写调用不留活动痕迹", async () => {
    const { installMcpHost, mcpUi } = await import("./mcp-host");
    const { agentActivity } = await import("./canvas/agent-activity");
    installMcpHost();
    const handle = onlyListener();
    const tabId = await openDoc();

    // 节点不存在：工具抛错，事务回滚
    await handle({ id: 1, name: "update_node", args: { nodeId: "nope", name: "改个名", tabId } });

    expect(responses[0]?.ok).toBe(false);
    expect(mcpUi.activity).toBeNull();
    expect(agentActivity.rects).toHaveLength(0);
  });
});

describe("文档工具的目标标签", () => {
  beforeEach(() => {
    resetHostState();
    vi.resetModules();
  });

  it("缺 tabId 直接拒绝，读写工具都不跑，文档零改动", async () => {
    const { installMcpHost } = await import("./mcp-host");
    const { docStore } = await import("./store");
    installMcpHost();
    const handle = onlyListener();
    const tabId = await openDoc();
    const before = Object.keys(docStore.doc.nodes).length;

    await handle({ id: 1, name: "create_node", args: { kind: "rect" } });
    await handle({ id: 2, name: "read_document", args: {} });

    expect(responses[0]?.ok).toBe(false);
    expect(responses[0]?.error).toContain("tabId");
    // 报错直接把活动标签写出来，agent 不必再查一次 app_state
    expect(responses[0]?.error).toContain(tabId);
    expect(responses[1]?.ok).toBe(false);
    expect(responses[1]?.error).toContain("tabId");
    expect(responses[1]?.error).toContain(tabId);
    // 空文档不会因为这次调用被"补建页面"
    expect(Object.keys(docStore.doc.nodes)).toHaveLength(before);
  });

  it("指向另一个打开的标签时报错，写明活动标签，两份文档都不动", async () => {
    const { installMcpHost } = await import("./mcp-host");
    const { createDocTab } = await import("./sessions");
    const { createEmptyDoc } = await import("@sqraft/core");
    installMcpHost();
    const handle = onlyListener();
    const activeId = await openDoc();
    const other = createDocTab(createEmptyDoc());
    const before = Object.keys(other.store.doc.nodes).length;

    await handle({ id: 1, name: "create_node", args: { kind: "rect", tabId: other.id } });

    expect(responses[0]?.ok).toBe(false);
    expect(responses[0]?.error).toContain(other.id);
    expect(responses[0]?.error).toContain(activeId);
    expect(Object.keys(other.store.doc.nodes)).toHaveLength(before);
  });

  it("未知 tabId 列出手上打开的标签", async () => {
    const { installMcpHost } = await import("./mcp-host");
    installMcpHost();
    const handle = onlyListener();
    const tabId = await openDoc();

    await handle({ id: 1, name: "create_node", args: { kind: "rect", tabId: "t-nope" } });

    expect(responses[0]?.ok).toBe(false);
    expect(responses[0]?.error).toContain("No open document tab");
    expect(responses[0]?.error).toContain(tabId);
  });

  it("tabId 是当前活动标签时正常执行", async () => {
    const { installMcpHost } = await import("./mcp-host");
    const { docStore } = await import("./store");
    installMcpHost();
    const handle = onlyListener();
    const tabId = await openDoc();

    await handle({ id: 1, name: "create_node", args: { kind: "rect", tabId } });

    expect(responses[0]?.ok).toBe(true);
    // 空文档会先建一页：页 + 矩形
    expect(Object.keys(docStore.doc.nodes)).toHaveLength(2);
  });
});
