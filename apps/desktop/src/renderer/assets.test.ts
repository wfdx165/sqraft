import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetIdFor, decodedSizeOf, imageFor, loadAssets, resetAssets, sniffMime } from "./assets";
import { hooks } from "./store";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("图片格式识别", () => {
  it("PNG magic bytes", () => {
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe("image/png");
  });

  it("JPEG magic bytes", () => {
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0))).toBe("image/jpeg");
  });

  it("GIF / WebP", () => {
    expect(sniffMime(new TextEncoder().encode("GIF89a______"))).toBe("image/gif");
    const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP")]);
    expect(sniffMime(webp)).toBe("image/webp");
  });

  it("SVG 按文本开头识别", () => {
    expect(sniffMime(new TextEncoder().encode('<?xml version="1.0"?><svg viewBox="0 0 1 1"/>'))).toBe(
      "image/svg+xml",
    );
    expect(sniffMime(new TextEncoder().encode("<svg></svg>"))).toBe("image/svg+xml");
  });

  it("扩展名不可信：不认识的字节一律 null", () => {
    expect(sniffMime(new TextEncoder().encode("not an image"))).toBeNull();
    expect(sniffMime(bytes())).toBeNull();
  });
});

describe("资源 id", () => {
  it("同样的内容得到同样的 id，不同内容不同", async () => {
    const a = await assetIdFor(bytes(1, 2, 3));
    const b = await assetIdFor(bytes(1, 2, 3));
    const c = await assetIdFor(bytes(1, 2, 4));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
  });
});

describe("解码预算按解码后的体积记账", () => {
  it("RGBA：宽 × 高 × 4", () => {
    expect(decodedSizeOf({ width: 100, height: 50 })).toBe(100 * 50 * 4);
    expect(decodedSizeOf({ width: 0, height: 0 })).toBe(1);
  });

  it("压缩率高的大图也按真实内存记账（不是文件字节数）", () => {
    const compressed = 3 * 1024 * 1024; // 3MB 的 PNG
    const decoded = decodedSizeOf({ width: 8192, height: 8192 });
    expect(decoded).toBeGreaterThan(compressed * 80);
  });
});

describe("按需解码", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => {} }));
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 64, height: 32, close: () => {} })),
    );
    hooks.requestRedraw = vi.fn();
    resetAssets();
  });

  afterEach(() => {
    resetAssets();
    vi.unstubAllGlobals();
  });

  it("第一帧返回 null 并请求重绘，解码完就有图了", async () => {
    loadAssets({ "assets/abc.png": PNG });
    expect(imageFor("abc")).toBeNull();
    // 解码完成后自己叫一次重绘，否则打开文件会一直停在占位块
    await vi.waitFor(() => expect(hooks.requestRedraw).toHaveBeenCalledTimes(1));
    expect(imageFor("abc")).not.toBeNull();
  });

  it("未解码时连续调用只起一次解码", async () => {
    loadAssets({ "assets/def.png": PNG });
    imageFor("def");
    imageFor("def");
    imageFor("def");
    await vi.waitFor(() => expect(imageFor("def")).not.toBeNull());
    expect(vi.mocked(createImageBitmap)).toHaveBeenCalledTimes(1);
  });
});
