import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRpc, type McpToolHost } from "./session";
import { setMcpLogSink } from "./log";

beforeEach(() => setMcpLogSink(() => {}));
afterEach(() => setMcpLogSink(null));

const host: McpToolHost = {
  list: () => [
    { name: "read_document", description: "读文档", inputSchema: { type: "object", properties: {} } },
  ],
  call: async (name, args) => {
    if (name === "boom") throw new Error("工具炸了");
    return JSON.stringify({ echo: args.value ?? null });
  },
};

const options = { version: "0.0.1" };

describe("MCP 协议处理", () => {
  it("initialize 回显协议版本与服务器信息", async () => {
    const response = await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      host,
      options,
    );
    expect(response).toMatchObject({
      id: 1,
      result: { protocolVersion: "2024-11-05", serverInfo: { name: "sqraft", version: "0.0.1" } },
    });
  });

  it("tools/list 返回宿主提供的清单", async () => {
    const response = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, host, options);
    expect(response).toMatchObject({ result: { tools: [{ name: "read_document" }] } });
  });

  it("tools/call 把执行结果包成文本内容", async () => {
    const response = await handleRpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { value: 7 } } },
      host,
      options,
    );
    const result = (response as { result: { content: { text: string }[] } }).result;
    expect(JSON.parse(result.content[0].text)).toEqual({ echo: 7 });
  });

  it("工具抛错时返回 isError 与可读原因，而不是 JSON-RPC 错误", async () => {
    const response = await handleRpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom" } },
      host,
      options,
    );
    expect(response).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: "工具炸了" }] },
    });
  });

  it("未知方法返回 -32601", async () => {
    const response = await handleRpc({ jsonrpc: "2.0", id: 5, method: "nope" }, host, options);
    expect(response).toMatchObject({ error: { code: -32601 } });
  });

  it("通知（无 id）不产生响应", async () => {
    const response = await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, host, options);
    expect(response).toBeNull();
  });

  it("截图结果转成 image content", async () => {
    const imageHost: McpToolHost = {
      list: () => [],
      call: async () => JSON.stringify({ ok: true, image: "data:image/png;base64,QUJD" }),
    };
    const response = await handleRpc(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "screenshot" } },
      imageHost,
      options,
    );
    const content = (response as { result: { content: Array<Record<string, unknown>> } }).result.content;
    expect(content[0]).toMatchObject({ type: "image", data: "QUJD", mimeType: "image/png" });
  });
});
