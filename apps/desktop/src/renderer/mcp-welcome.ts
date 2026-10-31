/**
 * 欢迎页的 MCP 区块：状态推导与客户端片段（纯函数，便于单测）。
 *
 * 传输换成 HTTP 之后没有"装命令行工具"这一步了（ADR-0026）：
 * 状态只剩三种——服务没起来 / 起来了但没人连 / 有 agent 在线。
 * 片段按客户端外壳不同，内容都是同一个 URL。
 */
import type { McpSetupInfo } from "../shared/ipc";

export type McpWelcomeState = "offline" | "idle" | "connected";

/** 欢迎页上可切换的客户端预设：外壳不同，指向的是同一个端点 */
export type McpClient = "claude" | "opencode" | "cursor" | "generic";

export const MCP_CLIENTS: ReadonlyArray<{ id: McpClient; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
  { id: "cursor", label: "Cursor" },
  { id: "generic", label: "通用" },
];

/** 某个客户端的接入片段；配置还没读到时返回空串（按钮据此禁用） */
export function clientSnippet(info: McpSetupInfo | null, client: McpClient): string {
  if (!info) return "";
  switch (client) {
    case "claude":
      return info.commandLine;
    case "opencode":
      return info.opencodeJson;
    case "cursor":
      return info.cursorJson;
    case "generic":
      return info.url;
  }
}

/** 有会话就压过服务状态：agent 已经在用了，不必再提怎么接 */
export function welcomeMcpState(info: McpSetupInfo | null, clients: readonly unknown[]): McpWelcomeState {
  if (clients.length > 0) return "connected";
  if (info && !info.listening) return "offline";
  return "idle";
}

/** 状态行：监听状态 + 在线人数；启动失败时带原因（端口被占最常见） */
export function statusLine(status: { listening: boolean; clients: readonly unknown[]; error?: string | null }): string {
  if (!status.listening) {
    return status.error ? `MCP 服务未启动 · ${status.error}` : "MCP 服务未启动";
  }
  if (status.clients.length > 0) return `MCP 服务监听中 · 已连接 ${status.clients.length} 个 agent`;
  return "MCP 服务监听中 · 等待 agent 接入";
}

export function actionText(state: McpWelcomeState): string {
  switch (state) {
    case "offline":
      return "检查端口";
    case "idle":
      return "复制接入命令";
    case "connected":
      return "已连接";
  }
}
