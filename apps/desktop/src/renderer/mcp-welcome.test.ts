import { describe, expect, it } from "vitest";
import type { McpSetupInfo } from "../shared/ipc";
import { actionText, clientCommand, statusLine, welcomeMcpState } from "./mcp-welcome";

function info(overrides: Partial<McpSetupInfo> = {}): McpSetupInfo {
  return {
    cliPath: "/Applications/Sqraft.app/Contents/Resources/bin/sqraft-mcp",
    installed: false,
    installedPath: null,
    targetDir: "/usr/local/bin",
    commandLine: "claude mcp add sqraft -- node /Applications/Sqraft.app/Contents/Resources/bin/sqraft-mcp",
    opencodeCommand:
      "opencode mcp add sqraft --global -- node /Applications/Sqraft.app/Contents/Resources/bin/sqraft-mcp",
    json: "{}",
    opencodeJson: "{}",
    ...overrides,
  };
}

describe("欢迎页的 MCP 三态", () => {
  it("没读配置（null）时按未安装处理", () => {
    expect(welcomeMcpState(null, [])).toBe("not-installed");
  });

  it("装了但没人连 → idle", () => {
    expect(welcomeMcpState(info({ installed: true }), [])).toBe("idle");
  });

  it("有 agent 在线时压过安装状态", () => {
    expect(welcomeMcpState(info({ installed: false }), [{}, {}])).toBe("connected");
  });

  it("三个状态各有自己的主按钮文案", () => {
    expect(actionText("not-installed")).toBe("安装命令行工具");
    expect(actionText("idle")).toBe("复制接入命令");
    expect(actionText("connected")).toBe("已连接");
  });
});

describe("客户端预设", () => {
  it("两个客户端各自给出自己的命令", () => {
    const data = info({ installed: true });
    expect(clientCommand(data, "claude")).toContain("claude mcp add sqraft -- node ");
    expect(clientCommand(data, "opencode")).toContain("opencode mcp add sqraft --global -- node ");
  });

  it("配置还没读到时返回空串（复制按钮据此禁用）", () => {
    expect(clientCommand(null, "claude")).toBe("");
    expect(clientCommand(null, "opencode")).toBe("");
  });
});

describe("欢迎页的状态行", () => {
  it("监听中且无连接", () => {
    expect(statusLine({ listening: true, clients: [] })).toBe("MCP 服务监听中 · 等待 agent 接入");
  });

  it("监听中并报出在线人数", () => {
    expect(statusLine({ listening: true, clients: [{}, {}, {}] })).toBe("MCP 服务监听中 · 已连接 3 个 agent");
  });

  it("服务没起来时如实说，不假装在线", () => {
    expect(statusLine({ listening: false, clients: [] })).toBe("MCP 服务未启动");
  });
});
