import { describe, expect, it } from "vitest";
import { firstFamilyOf, parseFontMeta, sniffFontMime } from "./fonts";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("字体格式识别", () => {
  it("按 magic bytes 认出 ttf / otf / woff / woff2", () => {
    expect(sniffFontMime(bytes(0x00, 0x01, 0x00, 0x00, 0, 0))).toBe("font/ttf");
    expect(sniffFontMime(new TextEncoder().encode("OTTO...."))).toBe("font/otf");
    expect(sniffFontMime(new TextEncoder().encode("wOFF...."))).toBe("font/woff");
    expect(sniffFontMime(new TextEncoder().encode("wOF2...."))).toBe("font/woff2");
  });

  it("不认识的内容返回 null（图片、文本都不会被当字体）", () => {
    expect(sniffFontMime(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(sniffFontMime(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
  });
});

describe("字体元数据解析", () => {
  it("截断/垃圾数据不抛异常，返回 null 交给文件名兜底", () => {
    expect(parseFontMeta(bytes(0x00, 0x01, 0x00, 0x00))).toBeNull();
    expect(parseFontMeta(new TextEncoder().encode("OTTO"))).toBeNull();
    expect(parseFontMeta(bytes(1, 2, 3))).toBeNull();
  });
});

describe("字体栈的第一个字族", () => {
  it("带引号/不带引号都能取到", () => {
    expect(firstFamilyOf("'Inter', sans-serif")).toBe("Inter");
    expect(firstFamilyOf('"PingFang SC", sans-serif')).toBe("PingFang SC");
    expect(firstFamilyOf("Inter, sans-serif")).toBe("Inter");
    expect(firstFamilyOf("sans-serif")).toBe("sans-serif");
    expect(firstFamilyOf("")).toBe("");
  });

  it("不用子串匹配（Inter 不会命中 Inter Tight）", () => {
    expect(firstFamilyOf("'Inter', sans-serif")).toBe("Inter");
    expect(firstFamilyOf("'Inter Tight', sans-serif")).toBe("Inter Tight");
  });
});
