/**
 * MCP 的本机传输：一条连接 = 一个 agent 客户端。
 * 先做 hello 版本握手，之后是换行分隔的 JSON-RPC；所有调用经全局串行队列。
 */
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { MCP_PROTOCOL_VERSION } from "./endpoint";
import { SerialQueue } from "./queue";
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

  // Unix socket 会留下文件；启动前先清掉上一次的残留
  if (process.platform !== "win32") await rm(options.endpoint, { force: true });

  const server = createServer((socket) => {
    clients.add(socket);
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
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "无法解析的 JSON" } });
        return;
      }

      if (!greeted) {
        const hello = message as { type?: string; protocol?: number };
        if (hello?.type !== "hello" || hello.protocol !== protocol) {
          send({
            type: "hello-error",
            message: `协议不兼容：客户端 ${String(hello?.protocol ?? "未知")}，本应用支持 ${protocol}`,
          });
          socket.end();
          return;
        }
        greeted = true;
        send({ type: "hello-ok", protocol, appVersion: options.appVersion });
        return;
      }

      const request = message as JsonRpcRequest;
      queue
        .enqueue(() => handleRpc(request, options.host, { version: options.appVersion }), {
          isAlive: () => !socket.destroyed,
        })
        .then((response) => {
          if (response) send(response);
        })
        .catch((error: unknown) => {
          send({
            jsonrpc: "2.0",
            id: request.id ?? null,
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          });
        });
    });

    const drop = (): void => {
      if (!clients.has(socket)) return;
      clients.delete(socket);
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

  return {
    clientCount: () => clients.size,
    broadcastShutdown: () => {
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
