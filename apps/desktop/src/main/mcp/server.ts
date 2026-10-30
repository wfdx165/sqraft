/**
 * MCP 的本机传输：一条连接 = 一个 agent 客户端。
 * 先做 hello 版本握手，之后是换行分隔的 JSON-RPC；所有调用经全局串行队列。
 */
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { MCP_PROTOCOL_VERSION } from "./endpoint";
import { formatClientIdentity, logError, logInfo, logWarn, type McpClientIdentity } from "./log";
import { ClientGoneError, QueueTimeoutError, SerialQueue } from "./queue";
import { handleRpc, type JsonRpcRequest, type McpToolHost } from "./session";

export interface McpRuntime {
  clientCount(): number;
  broadcastShutdown(): void;
  close(): Promise<void>;
}

export async function startMcpServer(options: {
  endpoint: string;
  host: McpToolHost;
  appVersion: string;
  protocol?: number;
  onClientChange?: (count: number) => void;
}): Promise<McpRuntime> {
  const protocol = options.protocol ?? MCP_PROTOCOL_VERSION;
  const queue = new SerialQueue();
  const clients = new Set<Socket>();
  /** 连接序号：日志里区分"同时连着的几个 agent"，重启归零。 */
  let sequence = 0;

  // Unix socket 会留下文件；启动前先清掉上一次的残留
  if (process.platform !== "win32") await rm(options.endpoint, { force: true });

  const server = createServer((socket) => {
    const clientId = `c${++sequence}`;
    // 拿到 hello 里的身份后补成 `c1 claude(8123)`；旧 CLI 不发就保持 `c1`
    let tag = clientId;
    clients.add(socket);
    logInfo(tag, "connect", { clients: clients.size });
    options.onClientChange?.(clients.size);
    let greeted = false;
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
        const identity = formatClientIdentity(hello);
        if (identity) tag = `${clientId} ${identity}`;
        send({ type: "hello-ok", protocol, appVersion: options.appVersion });
        logInfo(tag, "hello ok", { protocol, app: options.appVersion });
        return;
      }

      const request = message as JsonRpcRequest;
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
      if (!clients.has(socket)) return;
      clients.delete(socket);
      logInfo(tag, "disconnect", { clients: clients.size });
      options.onClientChange?.(clients.size);
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
    clientCount: () => clients.size,
    broadcastShutdown: () => {
      logInfo(null, "broadcast shutdown", { clients: clients.size });
      for (const client of clients) {
        if (!client.destroyed) socketSend(client, { jsonrpc: "2.0", method: "sqraft/shutdown" });
      }
    },
    close: async () => {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function socketSend(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}
