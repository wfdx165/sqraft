/**
 * MCP 的 HTTP 传输层：规范 Streamable HTTP（2025-11-25 / 2025-06-18 / 2025-03-26 都支持）。
 *
 * - `POST /mcp`：JSON-RPC 请求；`initialize` 成功时下发 `Mcp-Session-Id`，之后每个请求都要带；
 * - `DELETE /mcp`：主动结束会话；
 * - `GET /mcp`：不提供 SSE 流，返回 405（规范明确允许）；
 * - 只绑 loopback，拒绝带 `Origin` 的请求（防浏览器 DNS rebinding），`Host` 只认本机。
 *
 * 所有工具调用进同一条串行队列；会话空闲超时后自动过期，客户端下次请求会拿到 404 并重新
 * `initialize`。没有凭据：同机其他进程/用户也能连，这是相对 Unix socket 的显式取舍。
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpClientInfo } from "../../shared/ipc";
import { logError, logInfo, logWarn, singleLine } from "./log";
import { MCP_MAX_PORT } from "./port";
import { ClientGoneError, QueueTimeoutError, SerialQueue } from "./queue";
import {
  FALLBACK_PROTOCOL,
  isSupportedProtocol,
  SUPPORTED_PROTOCOLS,
  handleRpc,
  type JsonRpcRequest,
  type McpToolHost,
} from "./session";

export const MCP_SESSION_IDLE_MS = 30 * 60_000;
/** 界面上"在线"的判定窗口：HTTP 没有连接，只能按最近活动推断。 */
export const MCP_ACTIVE_WINDOW_MS = 2 * 60_000;
/** 请求体上限：要装得下 20MB 图片的 base64。 */
export const MCP_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const MCP_PATH = "/mcp";

const SESSION_ID_HEADER = "mcp-session-id";
const PROTOCOL_HEADER = "mcp-protocol-version";

export interface McpRuntime {
  /** 实际监听端口（自动模式下可能已经不是请求的那个） */
  readonly port: number;
  /** `http://127.0.0.1:<port>/mcp` */
  readonly url: string;
  /** 实际端口与请求端口不同（只有自动模式会这样） */
  readonly drifted: boolean;
  /** 当前活跃会话（只读快照，供状态栏与列表展示） */
  clients(): McpClientInfo[];
  close(): Promise<void>;
}

interface Session {
  id: string;
  label: string;
  connectedAt: number;
  lastSeen: number;
  lastTool?: string;
  lastToolAt?: number;
  closed: boolean;
}

export interface McpServerOptions {
  /** 绑定地址；默认 loopback，绝不用 0.0.0.0 */
  bindHost?: string;
  /** 首选端口；0 = 让系统分配（测试用） */
  port: number;
  /** 端口被占时向上顺延的步数；0 = 占用即失败 */
  fallbackSteps?: number;
  host: McpToolHost;
  appVersion: string;
  onClientChange?: (clients: McpClientInfo[]) => void;
  /** 会话空闲过期；默认 30 分钟 */
  sessionIdleMs?: number;
  /** 界面"在线"窗口；默认 2 分钟 */
  activeWindowMs?: number;
  /** 单次调用超时；默认 30s（测试用） */
  callTimeoutMs?: number;
  maxBodyBytes?: number;
  /** 端口扫描上界；默认 65535，测试用来稳定覆盖"没有可用端口"分支 */
  maxPort?: number;
  now?: () => number;
}

class BodyTooLargeError extends Error {}

export async function startMcpServer(options: McpServerOptions): Promise<McpRuntime> {
  const bindHost = options.bindHost ?? "127.0.0.1";
  const queue = new SerialQueue();
  const sessions = new Map<string, Session>();
  const now = options.now ?? Date.now;
  const idleMs = options.sessionIdleMs ?? MCP_SESSION_IDLE_MS;
  const activeWindowMs = options.activeWindowMs ?? MCP_ACTIVE_WINDOW_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MCP_MAX_BODY_BYTES;
  const maxPort = options.maxPort ?? MCP_MAX_PORT;
  const fallbackSteps = options.fallbackSteps ?? 0;
  let sequence = 0;
  /** 上一次广播过的活跃集合：定时 tick 只在集合变化时推送，避免每 30s 一次无意义 IPC */
  let lastActiveIds = "";

  /** 界面上展示的"在线"会话：最近 `activeWindowMs` 内有请求的那些。 */
  const activeClients = (): McpClientInfo[] => {
    const cutoff = now() - activeWindowMs;
    return [...sessions.values()]
      .filter((session) => session.lastSeen >= cutoff)
      .map(toClientInfo);
  };

  const emitClients = (force = true): void => {
    const list = activeClients();
    const signature = list.map((client) => client.id).join(",");
    if (!force && signature === lastActiveIds) return;
    lastActiveIds = signature;
    options.onClientChange?.(list);
  };

  const expire = (): void => {
    const cutoff = now() - idleMs;
    for (const [id, session] of sessions) {
      if (session.lastSeen >= cutoff) continue;
      session.closed = true;
      sessions.delete(id);
      logInfo(session.label, "session expired", { after: `${Math.round(idleMs / 1000)}s` });
    }
  };

  /** 定时做两件事：回收过期会话，并让界面上的"在线"集合随时间收敛。 */
  const tick = (): void => {
    expire();
    emitClients(false);
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      logError(null, "http handler failed", { error: reason });
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) sendJson(res, 500, rpcError(null, -32603, "服务内部错误"));
      else res.end();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = pathOf(req.url);
    if (path !== MCP_PATH) {
      sendText(res, 404, "not found");
      return;
    }
    // 浏览器发起的跨站请求一定带 Origin；合法 MCP 客户端不会带
    if (req.headers.origin !== undefined) {
      logWarn(null, "request rejected: origin header");
      sendText(res, 403, "不接受带 Origin 的请求");
      return;
    }
    if (!hostAllowed(req.headers.host)) {
      logWarn(null, "request rejected: host header", { host: req.headers.host });
      sendText(res, 403, "Host 不是本机地址");
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      res.setHeader("Allow", "POST, DELETE");
      sendText(res, 405, "不提供 SSE 流");
      return;
    }
    if (req.method === "DELETE") {
      handleDelete(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, DELETE");
      sendText(res, 405, "只支持 POST");
      return;
    }
    await handlePost(req, res);
  }

  function handleDelete(req: IncomingMessage, res: ServerResponse): void {
    const id = headerValue(req.headers[SESSION_ID_HEADER]);
    if (!id) {
      sendJson(res, 400, rpcError(null, -32600, "缺少 Mcp-Session-Id"));
      return;
    }
    const session = sessions.get(id);
    if (!session) {
      sendText(res, 404, "会话不存在或已过期");
      return;
    }
    session.closed = true;
    sessions.delete(id);
    logInfo(session.label, "session deleted", { clients: sessions.size });
    emitClients();
    res.writeHead(204, { "Content-Length": "0" });
    res.end();
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      sendText(res, 415, "Content-Type 必须是 application/json");
      return;
    }
    const versionHeader = headerValue(req.headers[PROTOCOL_HEADER]);
    if (versionHeader !== undefined && !isSupportedProtocol(versionHeader)) {
      sendJson(res, 400, rpcError(null, -32602, unsupportedVersionMessage(versionHeader)));
      return;
    }

    let body: string;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendText(res, 413, `请求体超过 ${Math.round(maxBodyBytes / (1024 * 1024))}MB`);
        return;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, rpcError(null, -32700, "无法解析的 JSON"));
      return;
    }
    if (Array.isArray(parsed)) {
      // 2025-06-18 已移除 JSON-RPC 批量请求
      sendJson(res, 400, rpcError(null, -32600, "不支持批量请求"));
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { method?: unknown }).method !== "string") {
      sendJson(res, 400, rpcError(null, -32600, "不是合法的 JSON-RPC 请求"));
      return;
    }
    const request = parsed as JsonRpcRequest;
    const isInitialize = request.method === "initialize";

    let session: Session | undefined;
    if (!isInitialize) {
      const id = headerValue(req.headers[SESSION_ID_HEADER]);
      if (!id) {
        sendJson(res, 400, rpcError(request.id ?? null, -32600, "缺少 Mcp-Session-Id；先调用 initialize"));
        return;
      }
      session = sessions.get(id);
      if (!session || session.closed) {
        sendText(res, 404, "会话不存在或已过期；请重新 initialize");
        return;
      }
      session.lastSeen = now();
      session.lastTool = request.method;
      session.lastToolAt = now();
      emitClients();
    }

    const tag = session?.label ?? null;
    let response;
    try {
      response = await queue.enqueue(
        () =>
          handleRpc(request, options.host, {
            version: options.appVersion,
            tag: tag ?? undefined,
          }),
        {
          isAlive: () => !session?.closed && !res.destroyed && !res.writableEnded,
          tag: tag ?? undefined,
          timeoutMs: options.callTimeoutMs,
        },
      );
    } catch (error) {
      if (error instanceof ClientGoneError) {
        // 客户端已经走了：没有接收方，不写响应
        return;
      }
      const timedOut = error instanceof QueueTimeoutError;
      const reason = error instanceof Error ? error.message : String(error);
      if (!timedOut) logError(tag, `rpc failed ${request.method}`, { error: reason });
      const failure = rpcError(request.id ?? null, -32603, reason);
      if (!res.headersSent && !res.destroyed) sendJson(res, 200, failure);
      return;
    }

    if (response === null) {
      // 通知：规范要求 202 且没有响应体
      res.writeHead(202, { "Content-Length": "0" });
      res.end();
      return;
    }

    if (isInitialize && "result" in response) {
      const id = randomUUID();
      const info: Session = {
        id,
        label: sessionLabel(`c${++sequence}`, request.params),
        connectedAt: now(),
        lastSeen: now(),
        closed: false,
      };
      sessions.set(id, info);
      const negotiated = (response as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
      const protocol = typeof negotiated === "string" ? negotiated : (versionHeader ?? FALLBACK_PROTOCOL);
      logInfo(info.label, "session created", { clients: sessions.size, protocol });
      emitClients();
      sendJson(res, 200, response, { [SESSION_ID_HEADER]: id });
      return;
    }

    if (session) {
      session.lastSeen = now();
      emitClients();
    }
    sendJson(res, 200, response);
  }

  /** 启动：从首选端口开始，被占时按 fallbackSteps 向上尝试。 */
  const requestedPort = options.port;
  let actualPort = requestedPort;
  let listening = false;
  for (let offset = 0; offset <= fallbackSteps; offset += 1) {
    const candidate = requestedPort === 0 ? 0 : requestedPort + offset;
    if (candidate > maxPort) break;
    try {
      await listenOn(server, candidate, bindHost);
      actualPort = candidate === 0 ? (server.address() as { port: number }).port : candidate;
      listening = true;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || offset === fallbackSteps) {
        await closeServer(server);
        const range =
          fallbackSteps === 0 ? `端口 ${requestedPort}` : `端口 ${requestedPort}–${requestedPort + fallbackSteps}`;
        throw new Error(
          code === "EADDRINUSE"
            ? `${range} 被占用`
            : `无法监听 ${bindHost}:${candidate}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (!listening) {
    await closeServer(server);
    throw new Error(`端口 ${requestedPort} 起没有可用端口（上限 ${maxPort}）`);
  }

  const expiry = setInterval(tick, Math.max(10, Math.min(30_000, Math.floor(idleMs / 2))));
  expiry.unref?.();

  logInfo(null, "server listening", { endpoint: `http://${bindHost}:${actualPort}${MCP_PATH}` });

  return {
    port: actualPort,
    url: `http://${bindHost}:${actualPort}${MCP_PATH}`,
    drifted: requestedPort !== 0 && actualPort !== requestedPort,
    clients: activeClients,
    close: async () => {
      clearInterval(expiry);
      for (const session of sessions.values()) session.closed = true;
      sessions.clear();
      await closeServer(server);
    },
  };
}

function toClientInfo(session: Session): McpClientInfo {
  return {
    id: session.id,
    label: session.label,
    connectedAt: session.connectedAt,
    lastToolAt: session.lastToolAt,
    lastTool: session.lastTool,
  };
}

/** `c1 claude-code/2.1`；客户端自报的名字不可信，压平换行并截断。 */
function sessionLabel(clientId: string, params: unknown): string {
  const info = (params as { clientInfo?: { name?: unknown; version?: unknown } } | undefined)?.clientInfo;
  const name = typeof info?.name === "string" ? info.name.trim() : "";
  const version = typeof info?.version === "string" ? info.version.trim() : "";
  const raw = version ? `${name}/${version}` : name;
  if (!raw) return clientId;
  const points = Array.from(singleLine(raw));
  return `${clientId} ${points.slice(0, 40).join("")}`;
}

function unsupportedVersionMessage(version: string): string {
  return `不支持的协议版本：${version}；本应用支持 ${SUPPORTED_PROTOCOLS.join("、")}`;
}

function pathOf(url: string | undefined): string {
  if (!url) return "";
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

/** 只接受本机 Host：防 DNS rebinding。端口已经在 socket 层限定，这里只校验主机名。 */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  if (res.destroyed || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        reject(new BodyTooLargeError("请求体过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host, exclusive: true });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
