/**
 * 欢迎页的 MCP 区块：状态推导与状态行（纯函数，便于单测）。
 *
 * 传输换成 HTTP 之后没有「装命令行工具」这一步了（ADR-0026）：
 * 状态只剩三种——服务没起来 / 起来了但没人连 / 有 agent 在线。
 * 客户端列表与接入动作在 `mcp-clients.ts`，本文件不再生成片段。
 */
import type { McpSetupInfo } from "../shared/ipc";
import { t } from "./i18n";

export type McpWelcomeState = "offline" | "idle" | "connected";

/** 有会话就压过服务状态：agent 已经在用了，不必再提怎么接 */
export function welcomeMcpState(info: McpSetupInfo | null, clients: readonly unknown[]): McpWelcomeState {
  if (clients.length > 0) return "connected";
  if (info && !info.listening) return "offline";
  return "idle";
}

/** 状态行：监听状态 + 在线人数；启动失败时带原因（端口被占最常见） */
export function statusLine(status: { listening: boolean; clients: readonly unknown[]; error?: string | null }): string {
  if (!status.listening) {
    return status.error ? t("mcp.status.offlineWithError", { error: status.error }) : t("mcp.status.offline");
  }
  if (status.clients.length > 0) return t("mcp.status.connected", { count: status.clients.length });
  return t("mcp.status.listening");
}
