import { describe, expect, it } from "vitest";
import { tokenColorOf, tokenNumberOf, tokenPathOf } from "../src/token-validation";

describe("Token 路径", () => {
  it("至少两段、允许任意层级", () => {
    expect(tokenPathOf("color/primary")).toBe("color/primary");
    expect(tokenPathOf("color/brand/50")).toBe("color/brand/50");
    expect(tokenPathOf("  颜色/主色  ")).toBe("颜色/主色");
  });

  it("拒绝缺段、空段与空白", () => {
    expect(tokenPathOf("brand")).toBeNull();
    expect(tokenPathOf("color//x")).toBeNull();
    expect(tokenPathOf("/color")).toBeNull();
    expect(tokenPathOf("color/")).toBeNull();
    expect(tokenPathOf("color/ x")).toBeNull();
    expect(tokenPathOf(undefined)).toBeNull();
  });
});

describe("Token 颜色", () => {
  it("接受 3/6/8 位 hex 与 rgb()/rgba()", () => {
    expect(tokenColorOf("#fff")).toBe("#fff");
    expect(tokenColorOf("#3366FF")).toBe("#3366FF");
    expect(tokenColorOf("#0f172a29")).toBe("#0f172a29");
    expect(tokenColorOf("rgb(0, 0, 0)")).toBe("rgb(0, 0, 0)");
    expect(tokenColorOf("rgba(0, 0, 0, 0.5)")).toBe("rgba(0, 0, 0, 0.5)");
    expect(tokenColorOf("rgb(0 0 0 / 50%)")).toBe("rgb(0 0 0 / 50%)");
  });

  it("拒绝命名色、hsl 与不完整写法", () => {
    expect(tokenColorOf("red")).toBeNull();
    expect(tokenColorOf("hsl(0, 0%, 0%)")).toBeNull();
    expect(tokenColorOf("#12")).toBeNull();
    expect(tokenColorOf("")).toBeNull();
    expect(tokenColorOf(12)).toBeNull();
  });
});

describe("Token 数值", () => {
  it("接受 number 与数字字符串", () => {
    expect(tokenNumberOf(12)).toBe(12);
    expect(tokenNumberOf("12")).toBe(12);
    expect(tokenNumberOf("-3.5")).toBe(-3.5);
  });

  it("拒绝空串、非有限值与其它类型", () => {
    expect(tokenNumberOf("")).toBeNull();
    expect(tokenNumberOf("   ")).toBeNull();
    expect(tokenNumberOf("Infinity")).toBeNull();
    expect(tokenNumberOf(Number.NaN)).toBeNull();
    expect(tokenNumberOf(true)).toBeNull();
    expect(tokenNumberOf(null)).toBeNull();
  });
});
