/**
 * 六个客户端 adapter 的装配点；ticket 04 的 IPC 从这里拿实例，不自己拼。
 */
import type { McpClientId } from "../../../shared/mcp-clients";
import { cliAdapters, type CliRunOptions } from "./cli-adapter";
import { createFileAdapters } from "./file-adapters";
import type { ClientAdapter, ClientContext } from "./types";

export function createAdapters(ctx: ClientContext, options: CliRunOptions = {}): ClientAdapter[] {
  return [...cliAdapters(ctx, options), ...createFileAdapters(ctx)];
}

export function adapterById(
  adapters: readonly ClientAdapter[],
  id: McpClientId,
): ClientAdapter | null {
  return adapters.find((adapter) => adapter.id === id) ?? null;
}
