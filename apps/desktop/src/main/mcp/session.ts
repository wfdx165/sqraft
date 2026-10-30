/**
 * 最小 MCP server 实现：只做 Sqraft 需要的能力（tools），不引 SDK。
 * 传输层与工具宿主都是注入的，因此可以在 Node 里直接测协议行为。
 */

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolHost {
  list(): McpToolInfo[];
  /** 返回工具执行器给的字符串（通常是 JSON），由这里包成 MCP content。 */
  call(name: string, args: Record<string, unknown>): Promise<string>;
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

const DEFAULT_PROTOCOL = "2024-11-05";

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
 */
export async function handleRpc(
  message: JsonRpcRequest,
  host: McpToolHost,
  options: { version: string },
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;

  const fail = (code: number, text: string): JsonRpcFailure => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });

  switch (message.method) {
    case "initialize": {
      const requested = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof requested === "string" ? requested : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "sqraft", version: options.version },
        },
      };
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: host.list().map((tool) => ({ ...tool, inputSchema: tool.inputSchema })) },
      };

    case "tools/call": {
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      const name = typeof params?.name === "string" ? params.name : "";
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (!name) return fail(-32602, "tools/call 缺少工具名");
      if (isNotification) return null;
      try {
        const raw = await host.call(name, args);
        return { jsonrpc: "2.0", id, result: { content: toContent(raw) } };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: textContent(error instanceof Error ? error.message : String(error)),
            isError: true,
          },
        };
      }
    }

    default:
      if (isNotification) return null;
      return fail(-32601, `不支持的方法：${message.method}`);
  }
}
