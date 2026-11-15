/**
 * 最小 MCP server 实现：只做 Sqraft 需要的能力（tools），不引 SDK。
 * 传输层与工具宿主都是注入的，因此可以在 Node 里直接测协议行为。
 */
import { logError, logInfo, logWarn } from "./log";
import { AGENT_INSTRUCTIONS } from "../../shared/agent-text";

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallOrigin {
  /** 会话标签（`c1 claude-code/2.1`）；宿主只用来给界面标注"谁在操作" */
  clientLabel?: string;
}

export interface McpToolHost {
  list(): McpToolInfo[];
  /** 返回工具执行器给的字符串（通常是 JSON），由这里包成 MCP content。 */
  call(name: string, args: Record<string, unknown>, origin?: McpCallOrigin): Promise<string>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** 支持的规范版本：三者都定义了 Streamable HTTP（2025-11-25 只是增量修订）。 */
export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOLS)[number];
/** 协商失败时的兜底版本：请求里没带 `MCP-Protocol-Version` 头按 2025-03-26 处理。 */
export const FALLBACK_PROTOCOL: ProtocolVersion = "2025-03-26";
export const LATEST_PROTOCOL: ProtocolVersion = "2025-11-25";

export function isSupportedProtocol(value: unknown): value is ProtocolVersion {
  return typeof value === "string" && (SUPPORTED_PROTOCOLS as readonly string[]).includes(value);
}

function textContent(text: string): Array<Record<string, unknown>> {
  return [{ type: "text", text }];
}

/** 执行器返回的字符串里如果带 data URL 图片（screenshot），转成 MCP 的 image content。 */
function toContent(raw: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw) as { image?: unknown };
    if (typeof parsed.image === "string" && parsed.image.startsWith("data:image/")) {
      const [header, data] = parsed.image.split(",");
      const mimeType = /data:([^;]+)/.exec(header)?.[1] ?? "image/png";
      return [
        { type: "image", data, mimeType },
        { type: "text", text: JSON.stringify({ ok: true }) },
      ];
    }
  } catch {
    /* 不是 JSON 就按纯文本返回 */
  }
  return textContent(raw);
}

/**
 * 处理一条 JSON-RPC 消息；通知（没有 id）返回 null。
 * 未知方法、参数错误、工具异常都映射成 JSON-RPC 错误，客户端能读到可读原因。
 *
 * 每次调用的完成行在这里打：耗时只算执行本身（排队等待由队列单独记）。
 */
export async function handleRpc(
  message: JsonRpcRequest,
  host: McpToolHost,
  options: { version: string; tag?: string; clientLabel?: string },
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;
  const tag = options.tag ?? null;

  const fail = (code: number, text: string): JsonRpcFailure => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });

  switch (message.method) {
    case "initialize": {
      const requested = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      // 规范：支持请求的版本就回同一个；否则回自己支持的最新版本，由客户端决定是否继续
      const supported = isSupportedProtocol(requested);
      const version = supported ? requested : LATEST_PROTOCOL;
      if (requested !== undefined && !supported) {
        logWarn(tag, "protocol downgraded", { requested: String(requested), negotiated: version });
      } else {
        logInfo(tag, "initialize", { protocol: version });
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "sqraft", version: options.version },
          // 大多数客户端会把它当系统提示注入：跨工具的流程规则写在这里
          instructions: AGENT_INSTRUCTIONS,
        },
      };
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list": {
      const list = host.list();
      logInfo(tag, `tools/list ${list.length} tools`);
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: list.map((tool) => ({ ...tool, inputSchema: tool.inputSchema })) },
      };
    }

    case "tools/call": {
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      const name = typeof params?.name === "string" ? params.name : "";
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (!name) {
        logWarn(tag, "tools/call missing name");
        return fail(-32602, "tools/call 缺少工具名");
      }
      if (isNotification) return null;
      const startedAt = Date.now();
      try {
        const raw = await host.call(name, args, { clientLabel: options.clientLabel });
        const elapsed = Date.now() - startedAt;
        // 超时之后才跑完的调用也走这里：耗时明显偏大就是"迟到完成"，能对上前面那条 warn
        logInfo(tag, `tools/call ${name} ok ${elapsed}ms`, { args });
        return { jsonrpc: "2.0", id, result: { content: toContent(raw) } };
      } catch (error) {
        const elapsed = Date.now() - startedAt;
        const reason = error instanceof Error ? error.message : String(error);
        logError(tag, `tools/call ${name} failed ${elapsed}ms`, { error: reason, args });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: textContent(reason),
            isError: true,
          },
        };
      }
    }

    default:
      if (isNotification) return null;
      logWarn(tag, `unknown method ${message.method}`);
      return fail(-32601, `不支持的方法：${message.method}`);
  }
}
