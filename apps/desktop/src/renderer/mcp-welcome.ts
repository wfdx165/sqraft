/**
 * 欢迎页的 MCP 区块：三态推导与文案都放在这里（纯函数，便于单测）。
 *
 * 三态：
 * - `not-installed`：还没把 CLI 装进 PATH —— 主按钮就是"装"
 * - `idle`：装好了但当前没有 agent 连着 —— 主按钮是"复制接入命令"
 * - `connected`：有 agent 在线 —— 不再给动作，只报人数
 */
import type { McpSetupInfo } from "../shared/ipc";

export type McpWelcomeState = "not-installed" | "idle" | "connected";

/** 欢迎页上可切换的客户端预设：命令形态不同，指向的是同一个 CLI */
export type McpClient = "claude" | "opencode";

/** 某个客户端的接入命令；配置还没读到时返回空串（按钮据此禁用） */
export function clientCommand(info: McpSetupInfo | null, client: McpClient): string {
  if (!info) return "";
  return client === "opencode" ? info.opencodeCommand : info.commandLine;
}

/** 有连接就压过安装状态：agent 已经在用了，不必再提安装 */
export function welcomeMcpState(info: McpSetupInfo | null, clients: readonly unknown[]): McpWelcomeState {
  if (clients.length > 0) return "connected";
  if (!info?.installed) return "not-installed";
  return "idle";
}

/** 状态行：监听状态 + 在线人数（端点路径刻意不显示，避免把内部路径当卖点） */
export function statusLine(status: { listening: boolean; clients: readonly unknown[] }): string {
  if (!status.listening) return "MCP 服务未启动";
  if (status.clients.length > 0) return `MCP 服务监听中 · 已连接 ${status.clients.length} 个 agent`;
  return "MCP 服务监听中 · 等待 agent 接入";
}

export function actionText(state: McpWelcomeState): string {
  switch (state) {
    case "not-installed":
      return "安装命令行工具";
    case "idle":
      return "复制接入命令";
    case "connected":
      return "已连接";
  }
}
