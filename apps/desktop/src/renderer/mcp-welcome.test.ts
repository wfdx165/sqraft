import { describe, expect, it } from "vitest";
import type { McpSetupInfo } from "../shared/ipc";
import { actionText, clientSnippet, MCP_CLIENTS, statusLine, welcomeMcpState } from "./mcp-welcome";

const URL = "http://127.0.0.1:7331/mcp";

function info(overrides: Partial<McpSetupInfo> = {}): McpSetupInfo {
  return {
    url: URL,
    port: 7331,
    explicitPort: null,
    driftFrom: null,
    listening: true,
    error: null,
    commandLine: `claude mcp add --transport http sqraft ${URL}`,
    opencodeJson: "{}",
    cursorJson: "{}",
    ...overrides,
  };
}

describe("欢迎页的 MCP 三态", () => {
  it("配置还没读到且没人连时按 idle 处理", () => {
    expect(welcomeMcpState(null, [])).toBe("idle");
  });

  it("服务没起来 → offline", () => {
    expect(welcomeMcpState(info({ listening: false, error: "端口被占用" }), [])).toBe("offline");
  });

  it("服务在监听但没人连 → idle", () => {
    expect(welcomeMcpState(info(), [])).toBe("idle");
  });

  it("有 agent 在线时压过服务状态", () => {
    expect(welcomeMcpState(info({ listening: false }), [{}, {}])).toBe("connected");
  });

  it("三个状态各有自己的主按钮文案", () => {
    expect(actionText("offline")).toBe("检查端口");
    expect(actionText("idle")).toBe("复制接入命令");
    expect(actionText("connected")).toBe("已连接");
  });
});

describe("客户端预设", () => {
  it("四个预设都指向同一个端点", () => {
    const data = info();
    expect(clientSnippet(data, "claude")).toContain(URL);
    expect(JSON.parse(clientSnippet(data, "opencode"))).toBeTruthy();
    expect(JSON.parse(clientSnippet(data, "cursor"))).toBeTruthy();
    expect(clientSnippet(data, "generic")).toBe(URL);
    expect(MCP_CLIENTS.map((item) => item.id)).toEqual(["claude", "opencode", "cursor", "generic"]);
  });

  it("配置还没读到时返回空串（复制按钮据此禁用）", () => {
    expect(clientSnippet(null, "claude")).toBe("");
    expect(clientSnippet(null, "generic")).toBe("");
  });
});

describe("欢迎页的状态行", () => {
  it("监听中且无会话", () => {
    expect(statusLine({ listening: true, clients: [] })).toBe("MCP 服务监听中 · 等待 agent 接入");
  });

  it("监听中并报出在线人数", () => {
    expect(statusLine({ listening: true, clients: [{}, {}, {}] })).toBe("MCP 服务监听中 · 已连接 3 个 agent");
  });

  it("服务没起来时带上原因，不假装在线", () => {
    expect(statusLine({ listening: false, clients: [], error: "端口 7331 被占用" })).toBe(
      "MCP 服务未启动 · 端口 7331 被占用",
    );
    expect(statusLine({ listening: false, clients: [] })).toBe("MCP 服务未启动");
  });
});
