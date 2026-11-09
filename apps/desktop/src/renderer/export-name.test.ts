import { describe, expect, it } from "vitest";
import { pngFileName } from "./export-name";

describe("导出 PNG 的文件名", () => {
  it("文档名 + 对象名", () => {
    expect(pngFileName("未命名", "矩形")).toBe("未命名-矩形.png");
    expect(pngFileName("电商改版.sqraft", "首页")).toBe("电商改版-首页.png");
  });

  it("对象名为空时只用文档名", () => {
    expect(pngFileName("未命名", "")).toBe("未命名.png");
    expect(pngFileName("未命名", "   ")).toBe("未命名.png");
  });

  it("非法字符换成连字符，压缩空白并截断", () => {
    expect(pngFileName("稿", "按钮/主:态*问?")).toBe("稿-按钮-主-态-问-.png");
    expect(pngFileName("稿", "a   b")).toBe("稿-a b.png");
    expect(pngFileName("稿", "x".repeat(200)).length).toBeLessThanOrEqual("稿-".length + 80 + ".png".length);
  });

  it("文档名缺失时退回「未命名」", () => {
    expect(pngFileName("", "矩形")).toBe("未命名-矩形.png");
  });
});
