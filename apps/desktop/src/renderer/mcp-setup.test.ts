import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpSetupInfo } from "../shared/ipc";

function makeInfo(overrides: Partial<McpSetupInfo> = {}): McpSetupInfo {
  return {
    url: "http://127.0.0.1:7331/mcp",
    port: 7331,
    explicitPort: null,
    driftFrom: null,
    listening: true,
    error: null,
    commandLine: "claude mcp add --transport http sqraft http://127.0.0.1:7331/mcp",
    opencodeJson: "{}",
    cursorJson: "{}",
    ...overrides,
  };
}

const setupMock = vi.fn();
const setPortMock = vi.fn();

let mcpSetup: typeof import("./mcp-setup").mcpSetup;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubGlobal("window", { sqraft: { mcp: { setup: setupMock, setPort: setPortMock } } });
  ({ mcpSetup } = await import("./mcp-setup"));
});

describe("接入配置 store", () => {
  it("并发调用只打一次 IPC，结果共享", async () => {
    const info = makeInfo();
    setupMock.mockResolvedValue(info);

    const [a, b] = await Promise.all([mcpSetup.ensure(), mcpSetup.ensure()]);
    expect(setupMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(info);
    expect(b).toBe(info);
  });

  it("有缓存时不再请求，force 会重新读一次", async () => {
    setupMock.mockResolvedValue(makeInfo());
    await mcpSetup.ensure();
    await mcpSetup.ensure();
    expect(setupMock).toHaveBeenCalledTimes(1);

    setupMock.mockResolvedValue(makeInfo({ port: 7332 }));
    const forced = await mcpSetup.ensure(true);
    expect(setupMock).toHaveBeenCalledTimes(2);
    expect(forced?.port).toBe(7332);
  });

  it("改端口后两个界面读到同一份新配置", async () => {
    const next = makeInfo({ port: 7400, explicitPort: 7400 });
    setPortMock.mockResolvedValue(next);
    await mcpSetup.savePort(7400);
    expect(setPortMock).toHaveBeenCalledWith(7400);
    expect(mcpSetup.info.value).toEqual(next);
  });

  it("请求失败返回 null，且不清空已经拿到的值", async () => {
    const first = makeInfo();
    setupMock.mockResolvedValue(first);
    await mcpSetup.ensure();

    setupMock.mockRejectedValue(new Error("主进程没响应"));
    await expect(mcpSetup.ensure(true)).resolves.toBeNull();
    expect(mcpSetup.info.value).toEqual(first);
  });
});
