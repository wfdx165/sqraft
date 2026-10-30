/**
 * MCP 的本机传输：一条连接 = 一个 agent 客户端。
 * 先做 hello 版本握手，之后是换行分隔的 JSON-RPC；所有调用经全局串行队列。
 */
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { McpClientInfo } from "../../shared/ipc";
import { MCP_PROTOCOL_VERSION } from "./endpoint";
import { formatClientIdentity, logError, logInfo, logWarn, type McpClientIdentity } from "./log";
import { ClientGoneError, QueueTimeoutError, SerialQueue } from "./queue";
import { handleRpc, type JsonRpcRequest, type McpToolHost } from "./session";

export interface McpRuntime {
  /** 当前连接（只读快照，供状态栏与列表展示） */
  clients(): McpClientInfo[];
  broadcastShutdown(): void;
  close(): Promise<void>;
}

export async function startMcpServer(options: {
  endpoint: string;
  host: McpToolHost;
  appVersion: string;
  protocol?: number;
  onClientChange?: (clients: McpClientInfo[]) => void;
}): Promise<McpRuntime> {
  const protocol = options.protocol ?? MCP_PROTOCOL_VERSION;
  const queue = new SerialQueue();
  /** 心跳：30s 一次 ping，10s 没有 pong 就断开（只对声明支持心跳的客户端生效） */
  const HEARTBEAT_MS = 30_000;
  const PONG_TIMEOUT_MS = 10_000;
  const clients = new Map<Socket, McpClientInfo>();
  /** 连接序号：日志里区分"同时连着的几个 agent"，重启归零。 */
  let sequence = 0;

  // Unix socket 会留下文件；启动前先清掉上一次的残留
  if (process.platform !== "win32") await rm(options.endpoint, { force: true });

  const server = createServer((socket) => {
    const clientId = `c${++sequence}`;
    // 拿到 hello 里的身份后补成 `c1 claude(8123)`；旧 CLI 不发就保持 `c1`
    let tag = clientId;
    const info: McpClientInfo = { id: clientId, label: tag, connectedAt: Date.now() };
    clients.set(socket, info);
    logInfo(tag, "connect", { clients: clients.size });
    options.onClientChange?.([...clients.values()]);
    let greeted = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    /** 上一次 ping 是否还没收到 pong（超时按「未回」判断，而不是「距上次 pong 的时间」） */
    let awaitingPong = false;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;
    const lines = createInterface({ input: socket });
    const send = (value: unknown): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
    };

    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        logWarn(tag, "bad json", { bytes: Buffer.byteLength(trimmed, "utf8") });
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "无法解析的 JSON" } });
        return;
      }

      if (!greeted) {
        const hello = message as { type?: string; protocol?: number } & McpClientIdentity;
        if (hello?.type !== "hello" || hello.protocol !== protocol) {
          logWarn(tag, "hello failed", { protocol: hello?.protocol ?? "unknown", supported: protocol });
          send({
            type: "hello-error",
            message: `协议不兼容：客户端 ${String(hello?.protocol ?? "未知")}，本应用支持 ${protocol}`,
          });
          socket.end();
          return;
        }
        greeted = true;
        // 新版 CLI 在 hello 里声明支持心跳；旧 CLI 不声明，不踢
        if ((hello as { heartbeat?: boolean }).heartbeat === true) {
          heartbeat = setInterval(() => {
            if (socket.destroyed) return;
            awaitingPong = true;
            send({ type: "ping" });
            // 每个 ping 单独计时：下一个 tick 之前没回 pong 才断开
            pongTimer = setTimeout(() => {
              if (!awaitingPong) return;
              logWarn(tag, "heartbeat timeout", { clients: clients.size });
              socket.destroy();
            }, PONG_TIMEOUT_MS);
          }, HEARTBEAT_MS);
        }
        const identity = formatClientIdentity(hello);
        if (identity) tag = `${clientId} ${identity}`;
        info.label = tag;
        send({ type: "hello-ok", protocol, appVersion: options.appVersion });
        logInfo(tag, "hello ok", { protocol, app: options.appVersion });
        return;
      }

      // 心跳回应：不是 RPC 请求，别丢进队列
      if ((message as { type?: string }).type === "pong") {
        awaitingPong = false;
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
        return;
      }

      const request = message as JsonRpcRequest;
      info.lastTool = request.method;
      info.lastToolAt = Date.now();
      queue
        .enqueue(
          () => handleRpc(request, options.host, { version: options.appVersion, tag }),
          { isAlive: () => !socket.destroyed, tag },
        )
        .then((response) => {
          if (response) send(response);
        })
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          // 队列已经在决策点打过 warn（超时 / 客户端断开），这里不再重复记同一件事
          const knownByQueue = error instanceof QueueTimeoutError || error instanceof ClientGoneError;
          if (!knownByQueue) logError(tag, `rpc failed ${request.method}`, { error: reason });
          send({
            jsonrpc: "2.0",
            id: request.id ?? null,
            error: { code: -32603, message: reason },
          });
        });
    });

    const drop = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      if (pongTimer) clearTimeout(pongTimer);
      heartbeat = null;
      pongTimer = null;
      if (!clients.has(socket)) return;
      clients.delete(socket);
      logInfo(tag, "disconnect", { clients: clients.size });
      options.onClientChange?.([...clients.values()]);
    };
    socket.on("error", drop);
    socket.on("close", () => {
      drop();
      lines.close();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.endpoint, () => resolve());
  });
  logInfo(null, "server listening", { endpoint: options.endpoint, protocol });

  return {
    clients: () => [...clients.values()],
    broadcastShutdown: () => {
      logInfo(null, "broadcast shutdown", { clients: clients.size });
      for (const socket of clients.keys()) {
        if (!socket.destroyed) socketSend(socket, { jsonrpc: "2.0", method: "sqraft/shutdown" });
      }
    },
    close: async () => {
      for (const client of clients.keys()) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function socketSend(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}
