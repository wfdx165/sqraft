import { afterEach, describe, expect, it } from "vitest";
import {
  LINE_LIMIT,
  logError,
  logInfo,
  logWarn,
  formatClientIdentity,
  formatFields,
  formatLine,
  setMcpLogSink,
  singleLine,
  summarizeString,
  type McpLogLevel,
} from "./log";

const at = new Date(2026, 0, 1, 12, 34, 56, 789);

afterEach(() => setMcpLogSink(null));

describe("MCP 日志摘要", () => {
  it("长字符串截断并标注被吃掉的长度", () => {
    expect(summarizeString("a".repeat(260))).toBe(`${"a".repeat(200)}…(+60 chars)`);
  });

  it("按码点截断，不切出半个 emoji", () => {
    expect(summarizeString("😀".repeat(300))).toBe(`${"😀".repeat(200)}…(+100 chars)`);
  });

  it("data URL 折叠成图片类型与体积", () => {
    // base64 长度 4000 → 约 3000 字节
    expect(summarizeString(`data:image/png;base64,${"A".repeat(4000)}`)).toBe("[image png ~3KB]");
    expect(summarizeString("data:image/jpeg;base64,AAAA")).toBe("[image jpeg ~3B]");
  });

  it("不带 data: 前缀的裸 base64 折叠成体积", () => {
    expect(summarizeString("QUJD".repeat(500))).toBe("[base64 ~1KB]");
  });

  it("换行压平，保证一行一个事件", () => {
    expect(summarizeString("第一行\n第二行")).toBe("第一行\\n第二行");
  });

  it("参数保留键名与结构，只裁内容", () => {
    const fields = formatFields({ args: { x: 1, text: `${"z".repeat(203)}的尾巴` } });
    expect(fields).toContain('args={"x":1,"text":"');
    expect(fields).toMatch(/…\(\+\d+ chars\)/);
    expect(fields).not.toContain("的尾巴");
  });

  it("超深与超长数组用占位符而不是整段丢弃", () => {
    const nested = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(formatFields(nested)).toContain("{…}");
    expect(formatFields({ list: Array.from({ length: 60 }, (_, i) => i) })).toContain('"…(+10 items)"');
  });
});

describe("MCP 日志行", () => {
  it("格式固定：前缀、本地时间、级别、连接标签、事件、字段", () => {
    expect(formatLine("info", at, "c1 claude(8123)", "connect", { clients: 1 })).toBe(
      "[mcp] 12:34:56.789 info  c1 claude(8123) connect clients=1",
    );
  });

  it("没有标签与字段时不留下多余空格", () => {
    expect(formatLine("error", at, null, "server start failed")).toBe("[mcp] 12:34:56.789 error server start failed");
  });

  it("事件文本里的换行与转义序列不会伪造日志行或操纵终端", () => {
    const line = formatLine("info", at, "c1", "a\nb\u001b[2J");
    expect(line).toBe("[mcp] 12:34:56.789 info  c1 a\\nb\\u001b[2J");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u001b");
  });

  it("身份里的换行与控制字符同样被转义", () => {
    const identity = formatClientIdentity({ name: "evil\nname", pid: "1\u001b[2J" });
    expect(identity).toBe("evil\\nname(1\\u001b[2J)");
    expect(singleLine(identity)).toBe(identity);
  });

  it("超长身份截断，不能靠自报名字把行撑爆", () => {
    expect(formatClientIdentity({ name: "n".repeat(60) })).toBe(`${"n".repeat(40)}…(+20 chars)`);
  });

  it("整行超过上限时兜底截断", () => {
    const fields = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "y".repeat(190)]));
    const line = formatLine("info", at, "c1", "tools/call x", fields);
    expect(line.startsWith("[mcp] ")).toBe(true);
    expect(line.length).toBeLessThan(LINE_LIMIT + 40);
    expect(line).toContain("…(+");
    expect(line.endsWith("chars)")).toBe(true);
  });

  it("身份标签按可用字段降级", () => {
    expect(formatClientIdentity({ name: "claude", pid: 8123 })).toBe("claude(8123)");
    expect(formatClientIdentity({ name: "claude" })).toBe("claude");
    expect(formatClientIdentity({ pid: 8123 })).toBe("pid=8123");
    expect(formatClientIdentity({})).toBe("");
  });
});

describe("MCP 日志落点", () => {
  it("info/warn 与 error 分开发往 sink，并带上级别", () => {
    const seen: Array<{ level: McpLogLevel; line: string }> = [];
    setMcpLogSink((level, line) => seen.push({ level, line }));
    logInfo(null, "a");
    logWarn("c1", "b");
    logError("c1 claude(8123)", "c");

    expect(seen.map((entry) => entry.level)).toEqual(["info", "warn", "error"]);
    expect(seen[2].line).toContain("c1 claude(8123) c");
  });
});
