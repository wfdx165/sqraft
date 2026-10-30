import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpSetupInfo } from "../shared/ipc";

function makeInfo(overrides: Partial<McpSetupInfo> = {}): McpSetupInfo {
  return {
    cliPath: "/App/Resources/bin/sqraft-mcp",
    installed: false,
    installedPath: null,
    targetDir: "/usr/local/bin",
    commandLine: "claude mcp add sqraft -- node /App/Resources/bin/sqraft-mcp",
    opencodeCommand: "opencode mcp add sqraft --global -- node /App/Resources/bin/sqraft-mcp",
    json: "{}",
    opencodeJson: "{}",
    ...overrides,
  };
}

const setupMock = vi.fn();

let mcpSetup: typeof import("./mcp-setup").mcpSetup;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubGlobal("window", { sqraft: { mcp: { setup: setupMock } } });
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

  it("有缓存时不再请求，force 会重新读盘", async () => {
    setupMock.mockResolvedValue(makeInfo());
    await mcpSetup.ensure();
    await mcpSetup.ensure();
    expect(setupMock).toHaveBeenCalledTimes(1);

    setupMock.mockResolvedValue(makeInfo({ installed: true }));
    const forced = await mcpSetup.ensure(true);
    expect(setupMock).toHaveBeenCalledTimes(2);
    expect(forced?.installed).toBe(true);
  });

  it("set 之后两个界面读到同一份新配置", () => {
    const next = makeInfo({ installed: true, installedPath: "/usr/local/bin/sqraft-mcp" });
    mcpSetup.set(next);
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
