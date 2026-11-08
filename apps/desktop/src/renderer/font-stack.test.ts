import { describe, expect, it } from "vitest";
import { cjkSans, cjkSerif, defaultTextFontFamily, labelFont, uiFontStack } from "./font-stack";

describe("按语言选择 CJK 字体栈", () => {
  it("中文使用 PingFang", () => {
    expect(uiFontStack("zh-CN")).toContain("PingFang SC");
    expect(cjkSans("zh-CN")).toContain("Microsoft YaHei");
  });

  it("日文使用 Hiragino / Yu Gothic", () => {
    const stack = uiFontStack("ja-JP");
    expect(stack).toContain("Hiragino Sans");
    expect(stack).toContain("Yu Gothic");
    expect(stack).not.toContain("PingFang SC");
  });

  it("韩文使用 Apple SD Gothic Neo / Malgun Gothic", () => {
    const stack = uiFontStack("ko-KR");
    expect(stack).toContain("Apple SD Gothic Neo");
    expect(stack).toContain("Malgun Gothic");
  });

  it("字体栈带 Geist 前缀，标签字体为 11px", () => {
    expect(defaultTextFontFamily("ja-JP").startsWith('"Geist Variable"')).toBe(true);
    expect(labelFont("ko-KR").startsWith("11px ")).toBe(true);
  });

  it("衬线回退按语言区分", () => {
    expect(cjkSerif("zh-CN")).toContain("Songti SC");
    expect(cjkSerif("ja-JP")).toContain("Hiragino Mincho ProN");
    expect(cjkSerif("ko-KR")).toContain("AppleMyungjo");
  });
});
