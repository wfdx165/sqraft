import { describe, expect, it } from "vitest";
import { parseConfig, removeEntry, setEntry, stringProp, valueAt } from "./jsonc";

describe("JSONC 解析", () => {
  it("允许注释与尾逗号", () => {
    const result = parseConfig('{\n  // 用户注释\n  "a": 1,\n}\n');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1 });
  });

  it("语法错误返回 CONFIG_UNPARSABLE", () => {
    const result = parseConfig('{ "a": ');
    expect(result).toMatchObject({ ok: false, code: "CONFIG_UNPARSABLE" });
  });

  it("根不是对象返回 CONFIG_UNEXPECTED_SHAPE", () => {
    expect(parseConfig("[1, 2]")).toMatchObject({ ok: false, code: "CONFIG_UNEXPECTED_SHAPE" });
    expect(parseConfig("null")).toMatchObject({ ok: false, code: "CONFIG_UNEXPECTED_SHAPE" });
  });
});

describe("范围编辑", () => {
  it("空对象里插入嵌套条目", () => {
    const result = setEntry("{}\n", ["mcpServers", "sqraft"], { url: "http://127.0.0.1:7331/mcp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseConfig(result.value);
    expect(parsed.ok && valueAt(parsed.value, ["mcpServers", "sqraft"])).toEqual({
      url: "http://127.0.0.1:7331/mcp",
    });
  });

  it("保留注释、缩进与其它键", () => {
    const original = [
      "{",
      "  // 这个文件是用户手写的",
      '  "theme": "dark",',
      '  "mcpServers": {',
      '    "other": { "url": "https://example.com/mcp" }',
      "  }",
      "}",
      "",
    ].join("\n");
    const result = setEntry(original, ["mcpServers", "sqraft"], { url: "http://127.0.0.1:7331/mcp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("// 这个文件是用户手写的");
    expect(result.value).toContain('"theme": "dark"');
    expect(result.value).toContain('"other"');
    const parsed = parseConfig(result.value);
    expect(parsed.ok && valueAt(parsed.value, ["mcpServers", "other"])).toEqual({
      url: "https://example.com/mcp",
    });
  });

  it("覆盖已有条目不留下旧值", () => {
    const original = '{"mcpServers":{"sqraft":{"url":"http://127.0.0.1:7330/mcp"}}}\n';
    const result = setEntry(original, ["mcpServers", "sqraft"], { url: "http://127.0.0.1:7331/mcp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain("7330");
    expect(result.value).toContain("7331");
  });

  it("移除只删除目标属性，注释保留", () => {
    const original = [
      "{",
      "  // 注释还在",
      '  "mcpServers": {',
      '    "sqraft": { "url": "http://127.0.0.1:7331/mcp" },',
      '    "other": { "url": "https://example.com/mcp" }',
      "  }",
      "}",
      "",
    ].join("\n");
    const result = removeEntry(original, ["mcpServers", "sqraft"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("// 注释还在");
    expect(result.value).toContain('"other"');
    expect(result.value).not.toContain('"sqraft"');
  });

  it("移除不存在的属性返回原文", () => {
    const original = '{ "a": 1 }\n';
    const result = removeEntry(original, ["mcpServers", "sqraft"]);
    expect(result).toEqual({ ok: true, value: original });
  });

  it("父级不是对象时拒写", () => {
    const result = setEntry('{"mcpServers": []}\n', ["mcpServers", "sqraft"], { url: "x" });
    expect(result).toMatchObject({ ok: false, code: "CONFIG_UNEXPECTED_SHAPE" });
  });

  it("保留 CRLF", () => {
    const result = setEntry('{\r\n  "a": 1\r\n}\r\n', ["b"], 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("\r\n");
    expect(/[^\r]\n/.test(result.value)).toBe(false);
  });
});

describe("stringProp", () => {
  it("只接受非空字符串", () => {
    expect(stringProp({ url: "x" }, "url")).toBe("x");
    expect(stringProp({ url: "" }, "url")).toBeNull();
    expect(stringProp({ url: 1 }, "url")).toBeNull();
    expect(stringProp(null, "url")).toBeNull();
  });
});
