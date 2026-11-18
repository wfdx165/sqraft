/**
 * MCP 客户端标识与错误码：主进程与渲染层共用，不依赖 DOM / Node。
 *
 * 这里是白名单真源：主进程只认这 6 个 id，渲染层也只能传 id，
 * 路径、URL、argv 一律由主进程按 adapter 表解析（ADR-0036）。
 */

export const MCP_CLIENT_IDS = ["claude-code", "codex", "opencode", "cursor", "vscode", "zed"] as const;

export type McpClientId = (typeof MCP_CLIENT_IDS)[number];

export function isMcpClientId(value: unknown): value is McpClientId {
  return typeof value === "string" && (MCP_CLIENT_IDS as readonly string[]).includes(value);
}

/** 接入失败/需要用户处理的稳定错误码；UI 文案按码本地化，日志只记码与摘要。 */
export type McpClientIssueCode =
  | "CLI_MISSING"
  | "CLI_FAILED"
  | "CONFIG_UNPARSABLE"
  | "CONFIG_UNEXPECTED_SHAPE"
  | "TARGET_MISSING"
  | "VERIFY_FAILED"
  | "BACKUP_FAILED"
  | "WRITE_FAILED"
  | "CONFLICT"
  | "SYNC_FAILED"
  | "SERVER_DOWN";

export type McpClientChannel = "cli" | "file";
