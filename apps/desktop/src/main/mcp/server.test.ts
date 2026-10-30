import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMcpServer, type McpRuntime } from "./server";
import type { McpToolHost } from "./session";
import { setMcpLogSink } from "./log";

const dirs: string[] = [];
let runtime: McpRuntime | null = null;
const clients: Socket[] = [];
const logLines: string[] = [];

beforeEach(() => {
  logLines.length = 0;
  setMcpLogSink((_level, line) => logLines.push(line));
});

const host: McpToolHost = {
  list: () => [{ name: "read_document", description: "读文档", inputSchema: { type: "object" } }],
  call: async (name, args) => JSON.stringify({ name, args }),
};

async function setup(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-mcp-"));
  dirs.push(dir);
  const endpoint = join(dir, "mcp.sock");
  runtime = await startMcpServer({ endpoint, host, appVersion: "0.0.1" });
  return endpoint;
}

function connect(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint, () => resolve(socket));
    socket.once("error", reject);
    clients.push(socket);
  });
}

/** 逐行读取，按需取下一行。 */
function reader(socket: Socket) {
  let buffer = "";
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
      index = buffer.indexOf("\n");
    }
  });
  return () => {
    if (queue.length) return Promise.resolve(queue.shift()!);
    return new Promise<string>((resolve) => waiters.push(resolve));
  };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await runtime?.close();
  runtime = null;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// 断开事件在 socket 关闭后异步到达：整组测试结束再还原 sink，避免漏到终端
afterAll(() => setMcpLogSink(null));

describe.skipIf(process.platform === "win32")("MCP 本机传输", () => {
  it("协议版本不匹配时返回可读错误并断开", async () => {
    const endpoint = await setup();
    const socket = await connect(endpoint);
    const next = reader(socket);
    socket.write(`${JSON.stringify({ type: "hello", protocol: 999 })}\n`);
    const message = JSON.parse(await next());
    expect(message.type).toBe("hello-error");
    expect(message.message).toContain("999");
  });

  it("握手后能列工具、调用工具，并在退出时收到关闭通知", async () => {
    const endpoint = await setup();
    const socket = await connect(endpoint);
    const next = reader(socket);

    socket.write(`${JSON.stringify({ type: "hello", protocol: 1 })}\n`);
    expect(JSON.parse(await next())).toMatchObject({ type: "hello-ok", protocol: 1 });

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const listed = JSON.parse(await next());
    expect(listed.result.tools[0].name).toBe("read_document");

    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_document", arguments: { a: 1 } } })}\n`,
    );
    const called = JSON.parse(await next());
    expect(JSON.parse(called.result.content[0].text)).toEqual({ name: "read_document", args: { a: 1 } });

    runtime!.broadcastShutdown();
    expect(JSON.parse(await next())).toMatchObject({ method: "sqraft/shutdown" });
  });

  it("日志里留下来源、工具名、耗时与参数摘要", async () => {
    const endpoint = await setup();
    const socket = await connect(endpoint);
    const next = reader(socket);

    socket.write(`${JSON.stringify({ type: "hello", protocol: 1, pid: 8123, name: "claude" })}\n`);
    expect(JSON.parse(await next())).toMatchObject({ type: "hello-ok" });

    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_document", arguments: { a: 1 } } })}\n`,
    );
    await next();
    // ping 不该进日志（噪音大、无信息量）
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    await next();

    expect(logLines.join("\n")).not.toContain("ping");
    expect(logLines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/server listening endpoint=.+ protocol=1/),
        expect.stringMatching(/c\d+ connect clients=1/),
        expect.stringMatching(/c\d+ claude\(8123\) hello ok protocol=1 app=0\.0\.1/),
        expect.stringMatching(/c\d+ claude\(8123\) tools\/call read_document ok \d+ms args=\{"a":1\}/),
      ]),
    );
  });

  it("旧 CLI 不带身份字段时只记连接号", async () => {
    const endpoint = await setup();
    const socket = await connect(endpoint);
    const next = reader(socket);
    socket.write(`${JSON.stringify({ type: "hello", protocol: 1 })}\n`);
    await next();
    expect(logLines).toEqual(
      expect.arrayContaining([expect.stringMatching(/c\d+ hello ok protocol=1 app=0\.0\.1$/)]),
    );
  });

  it("hello 里的身份不能伪造日志行", async () => {
    const endpoint = await setup();
    const socket = await connect(endpoint);
    const next = reader(socket);
    socket.write(
      `${JSON.stringify({ type: "hello", protocol: 1, pid: 1, name: "evil\n[mcp] 00:00:00.000 error fake" })}\n`,
    );
    await next();

    expect(logLines.every((line) => !line.includes("\n"))).toBe(true);
    expect(logLines.some((line) => line.includes("evil\\n[mcp] 00:00:00.000 error fake"))).toBe(true);
  });

  it("并发调用被串行执行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqraft-mcp-"));
    dirs.push(dir);
    const order: string[] = [];
    runtime = await startMcpServer({
      endpoint: join(dir, "mcp.sock"),
      appVersion: "0.0.1",
      host: {
        list: () => [],
        call: async (name) => {
          order.push(`${name}:start`);
          await new Promise((resolve) => setTimeout(resolve, name === "slow" ? 30 : 1));
          order.push(`${name}:end`);
          return "{}";
        },
      },
    });
    const socket = await connect(join(dir, "mcp.sock"));
    const next = reader(socket);
    socket.write(`${JSON.stringify({ type: "hello", protocol: 1 })}\n`);
    await next();
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } })}\n`);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fast" } })}\n`);
    await next();
    await next();
    expect(order).toEqual(["slow:start", "slow:end", "fast:start", "fast:end"]);
  });
});
