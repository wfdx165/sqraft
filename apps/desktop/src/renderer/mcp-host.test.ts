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

    const request: McpCallRequest = { id: 7, name: "create_node", args: { kind: "rect" } };
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

    await handle({ id: 1, name: "create_node", args: { kind: "rect" } });
    await handle({ id: 2, name: "create_node", args: { kind: "ellipse" } });

    expect(responses).toHaveLength(2);
    expect(responses.every((entry) => entry.ok)).toBe(true);
    expect(Object.keys(docStore.doc.nodes)).toHaveLength(3);
  });
});
