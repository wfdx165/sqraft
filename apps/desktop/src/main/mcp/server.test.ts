import { request as httpRequest } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setMcpLogSink } from "./log";
import { startMcpServer, type McpRuntime, type McpServerOptions } from "./server";
import type { McpToolHost } from "./session";

let runtime: McpRuntime | null = null;
const runtimes: McpRuntime[] = [];
const logLines: string[] = [];

beforeEach(() => {
  logLines.length = 0;
  setMcpLogSink((_level, line) => logLines.push(line));
});

afterEach(async () => {
  for (const extra of runtimes.splice(0)) await extra.close().catch(() => {});
  await runtime?.close();
  runtime = null;
});

afterAll(() => setMcpLogSink(null));

const host: McpToolHost = {
  list: () => [{ name: "read_document", description: "读文档", inputSchema: { type: "object" } }],
  call: async (name, args) => {
    if (name === "boom") throw new Error("工具炸了");
    return JSON.stringify({ name, args });
  },
};

async function setup(overrides: Partial<McpServerOptions> = {}): Promise<McpRuntime> {
  runtime = await startMcpServer({
    bindHost: "127.0.0.1",
    port: 0,
    fallbackSteps: 0,
    host,
    appVersion: "0.0.1",
    sessionIdleMs: 60_000,
    ...overrides,
  });
  return runtime;
}

function rpc(body: unknown, headers: Record<string, string> = {}, method = "POST", path = "/mcp") {
  return fetch(`http://127.0.0.1:${runtime!.port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body) }),
  });
}

async function initialize(extra: Record<string, string> = {}): Promise<Response> {
  return rpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", clientInfo: { name: "claude-code", version: "2.1" } },
    },
    extra,
  );
}

async function sessionId(): Promise<string> {
  const response = await initialize();
  return response.headers.get("mcp-session-id")!;
}

describe("MCP HTTP 传输", () => {
  it("initialize 下发会话 id，并协商到客户端请求的版本", async () => {
    const server = await setup();
    const response = await initialize();
    expect(response.status).toBe(200);
    const id = response.headers.get("mcp-session-id");
    expect(id).toBeTruthy();
    const body = (await response.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe("2025-11-25");
    expect(body.result.serverInfo.name).toBe("sqraft");
    expect(server.clients()).toHaveLength(1);
    expect(server.clients()[0].label).toContain("claude-code/2.1");
  });

  it("不支持的协议版本回落到最新版，并照常建会话", async () => {
    const server = await setup();
    const response = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    const body = (await response.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-11-25");
    expect(server.clients()).toHaveLength(1);
    expect(logLines.join("\n")).toContain("protocol downgraded");
  });

  it("没有会话 id 的请求返回 400，伪造的返回 404", async () => {
    await setup();
    const missing = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(missing.status).toBe(400);

    const unknown = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { "mcp-session-id": "does-not-exist" },
    );
    expect(unknown.status).toBe(404);
  });

  it("带会话时能列工具、调工具，通知返回 202", async () => {
    await setup();
    const id = await sessionId();

    const listed = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { "mcp-session-id": id });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools[0].name).toBe("read_document");

    const called = await rpc(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_document", arguments: { a: 1 } } },
      { "mcp-session-id": id },
    );
    const callBody = (await called.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(callBody.result.content[0].text)).toEqual({ name: "read_document", args: { a: 1 } });

    const notified = await rpc(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { "mcp-session-id": id },
    );
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe("");
  });

  it("工具抛错时返回 isError 与可读原因", async () => {
    await setup();
    const id = await sessionId();
    const response = await rpc(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "boom" } },
      { "mcp-session-id": id },
    );
    const body = (await response.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe("工具炸了");
  });

  it("tools/call 之后 lastTool 记的是工具名，不是方法名", async () => {
    const server = await setup();
    const id = await sessionId();
    await rpc(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_document", arguments: {} } },
      { "mcp-session-id": id },
    );
    expect(server.clients()[0].lastTool).toBe("read_document");
  });

  it("tools/call 把客户端标签透传给宿主", async () => {
    const seen: Array<string | undefined> = [];
    await setup({
      host: {
        list: () => [],
        call: async (_name, _args, origin) => {
          seen.push(origin?.clientLabel);
          return "{}";
        },
      },
    });
    const id = await sessionId();
    await rpc(
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "read_document", arguments: {} } },
      { "mcp-session-id": id },
    );
    expect(seen).toEqual([expect.stringContaining("claude-code/2.1")]);
  });

  it("DELETE 结束会话，之后再用该 id 返回 404", async () => {
    const server = await setup();
    const id = await sessionId();
    const removed = await rpc({}, { "mcp-session-id": id }, "DELETE");
    expect(removed.status).toBe(204);
    expect(server.clients()).toHaveLength(0);

    const after = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/list" }, { "mcp-session-id": id });
    expect(after.status).toBe(404);
  });

  it("GET 不提供 SSE，返回 405 且声明允许的方法", async () => {
    await setup();
    const response = await rpc({}, {}, "GET");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, DELETE");
  });

  it("带 Origin 的请求直接拒绝（防浏览器 DNS rebinding）", async () => {
    await setup();
    const response = await rpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { Origin: "http://evil.example" },
    );
    expect(response.status).toBe(403);
  });

  it("Host 不是本机地址时拒绝", async () => {
    const server = await setup();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: "evil.example",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    });
    expect(status).toBe(403);
  });

  it("Content-Type 不是 JSON 返回 415，非法 JSON 返回 400", async () => {
    await setup();
    const wrongType = await fetch(`http://127.0.0.1:${runtime!.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(wrongType.status).toBe(415);

    const bad = await rpc("{not json");
    expect(bad.status).toBe(400);
  });

  it("MCP-Protocol-Version 头不在支持集合时返回 400", async () => {
    await setup();
    const id = await sessionId();
    const response = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "mcp-session-id": id, "mcp-protocol-version": "1999-01-01" },
    );
    expect(response.status).toBe(400);
  });

  it("并发调用被串行执行", async () => {
    const order: string[] = [];
    await setup({
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
    const id = await sessionId();
    await Promise.all([
      rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } }, { "mcp-session-id": id }),
      rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fast" } }, { "mcp-session-id": id }),
    ]);
    expect(order).toEqual(["slow:start", "slow:end", "fast:start", "fast:end"]);
  });

  it("会话空闲超时后过期，人数归零", async () => {
    const server = await setup({ sessionIdleMs: 30 });
    const id = await sessionId();
    expect(server.clients()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.clients()).toHaveLength(0);

    const after = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-session-id": id });
    expect(after.status).toBe(404);
  });

  it("日志里留下会话标签、工具名、耗时与参数摘要", async () => {
    await setup();
    const id = await sessionId();
    await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_document", arguments: { a: 1 } } },
      { "mcp-session-id": id },
    );
    expect(logLines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/server listening endpoint=http:\/\/127\.0\.0\.1:\d+\/mcp/),
        expect.stringMatching(/c1 claude-code\/2\.1 session created/),
        expect.stringMatching(/c1 claude-code\/2\.1 tools\/call read_document ok \d+ms args=\{"a":1\}/),
      ]),
    );
  });

  it("客户端自报的名字不能伪造日志行", async () => {
    await setup();
    await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "evil\n[mcp] 00:00:00.000 error fake" },
      },
    });
    expect(logLines.every((line) => !line.includes("\n"))).toBe(true);
    expect(logLines.some((line) => line.includes("evil\\n[mcp]"))).toBe(true);
  });

  it("超过活跃窗口的会话从在线列表消失，但协议上仍然有效", async () => {
    let clock = 0;
    const server = await setup({ sessionIdleMs: 60_000, activeWindowMs: 100, now: () => clock });
    const id = await sessionId();
    expect(server.clients()).toHaveLength(1);

    clock += 200;
    expect(server.clients()).toHaveLength(0);

    const response = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": id });
    expect(response.status).toBe(200);
    // 请求把 lastSeen 拉回现在：重新出现在在线列表里
    expect(server.clients()).toHaveLength(1);
  });

  it("端口上界内没有可用端口时启动失败，而不是假装监听", async () => {
    await expect(
      startMcpServer({
        bindHost: "127.0.0.1",
        port: 7000,
        fallbackSteps: 5,
        maxPort: 6999,
        host,
        appVersion: "0.0.1",
      }),
    ).rejects.toThrow(/没有可用端口/);
  });

  it("客户端取消请求后服务不崩，下一次调用正常", async () => {
    await setup({
      host: {
        list: () => [],
        call: async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return "{}";
        },
      },
    });
    const id = await sessionId();

    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${runtime!.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": id },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "slow" } }),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow();
    // 等队列里的任务跑完（它会发现响应已销毁，直接丢弃）
    await new Promise((resolve) => setTimeout(resolve, 120));

    const after = await rpc({ jsonrpc: "2.0", id: 100, method: "tools/list" }, { "mcp-session-id": id });
    expect(after.status).toBe(200);
  });

  it("未带协议版本的客户端在日志里记真实协商结果", async () => {
    await setup();
    await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "legacy" } },
    });
    expect(logLines.join("\n")).toContain("protocol=2025-11-25");
  });

  it("端口被占时：显式端口直接失败，自动模式向上顺延", async () => {
    const first = await setup();
    const taken = first.port;

    await expect(
      startMcpServer({
        bindHost: "127.0.0.1",
        port: taken,
        fallbackSteps: 0,
        host,
        appVersion: "0.0.1",
      }),
    ).rejects.toThrow(/被占用/);

    const second = await startMcpServer({
      bindHost: "127.0.0.1",
      port: taken,
      fallbackSteps: 50,
      host,
      appVersion: "0.0.1",
    });
    runtimes.push(second);
    expect(second.port).not.toBe(taken);
    expect(second.drifted).toBe(true);
    expect(second.url).toContain(`:${second.port}/mcp`);
  });
});
