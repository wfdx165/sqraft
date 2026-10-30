/**
 * 本机 IPC 端点：macOS/Linux 用 Unix domain socket，Windows 用命名管道。
 * CLI（resources/bin/sqraft-mcp.js）里有一份等价实现，改动时两边必须同步。
 */
import { join } from "node:path";

export const MCP_PROTOCOL_VERSION = 1;
export const MCP_PIPE_NAME = "\\\\.\\pipe\\sqraft-mcp";

/** userData 目录下的 socket 路径；Windows 返回命名管道名。 */
export function mcpEndpoint(userDataDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? MCP_PIPE_NAME : join(userDataDir, "mcp.sock");
}
