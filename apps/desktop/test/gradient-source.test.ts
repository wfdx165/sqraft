import { describe, expect, it } from "vitest";
import type { NodeStyle, TokenEntry } from "@sqraft/core";
import { gradientTokenPathOf, gradientValueOf } from "../src/renderer/inspector/gradient-source";

const brand = {
  type: "linear" as const,
  from: { x: 0, y: 0.5 },
  to: { x: 1, y: 0.5 },
  stops: [
    { offset: 0, color: { token: "color/a" } },
    { offset: 1, color: { value: "#ffffff" } },
  ],
};

const tokens: Record<string, TokenEntry> = {
  "gradient/brand": { type: "gradient", value: brand },
  "color/a": { type: "color", value: "#6366f1" },
  "size/md": { type: "number", value: 16 },
  "gradient/broken": { type: "gradient", value: "oops" as never },
};

describe("检查器渐变来源判定", () => {
  it("字面量渐变直接返回，且不算 Token 引用", () => {
    const style: NodeStyle = { fill: brand };
    expect(gradientValueOf(style, "fill", tokens)).toBe(brand);
    expect(gradientTokenPathOf(style, "fill", tokens)).toBeUndefined();
  });

  it("引用渐变 Token 时两条判定都成立，值取 Token 里的那份", () => {
    const style: NodeStyle = { fill: { token: "gradient/brand" } };
    expect(gradientTokenPathOf(style, "fill", tokens)).toBe("gradient/brand");
    expect(gradientValueOf(style, "fill", tokens)).toBe(brand);
  });

  it("纯色 Token / 数值 Token / 缺失 Token 都不算渐变", () => {
    for (const token of ["color/a", "size/md", "gradient/missing"]) {
      const style: NodeStyle = { fill: { token } };
      expect(gradientTokenPathOf(style, "fill", tokens)).toBeUndefined();
      expect(gradientValueOf(style, "fill", tokens)).toBeUndefined();
    }
  });

  it("值是脏数据的渐变 Token 仍算引用（要显示引用条），但没有可编辑的渐变", () => {
    const style: NodeStyle = { fill: { token: "gradient/broken" } };
    expect(gradientTokenPathOf(style, "fill", tokens)).toBe("gradient/broken");
    expect(gradientValueOf(style, "fill", tokens)).toBeUndefined();
  });

  it("描边与填充互不影响", () => {
    const style: NodeStyle = { fill: { value: "#000000" }, stroke: { token: "gradient/brand" } };
    expect(gradientTokenPathOf(style, "stroke", tokens)).toBe("gradient/brand");
    expect(gradientTokenPathOf(style, "fill", tokens)).toBeUndefined();
  });

  it("没有填充时返回 undefined", () => {
    expect(gradientValueOf({}, "fill", tokens)).toBeUndefined();
  });
});
