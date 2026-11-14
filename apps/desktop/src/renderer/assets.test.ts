import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetIdFor, decodedSizeOf, ensureAssetDecoded, imageFor, loadAssets, resetAssets, sniffMime } from "./assets";
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
    hooks.requestRepaint = vi.fn();
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
    await vi.waitFor(() => expect(hooks.requestRepaint).toHaveBeenCalledTimes(1));
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

describe("分级解码（按屏幕所需分辨率）", () => {
  /** createImageBitmap 有多个重载，mock 的参数类型推不准：按 (blob, options) 取 */
  const bitmapOptions = (call: number) =>
    (vi.mocked(createImageBitmap).mock.calls[call] as unknown[])[1] as ImageBitmapOptions | undefined;

  /** 带 IHDR 的 PNG 头：读文件头就能拿到原图尺寸 */
  function pngOf(width: number, height: number, seed: number): Uint8Array {
    const b = new Uint8Array(40);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, width);
    new DataView(b.buffer).setUint32(20, height);
    b[39] = seed;
    return b;
  }

  beforeEach(() => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (_blob: Blob, opts?: ImageBitmapOptions) => ({
        width: opts?.resizeWidth ?? 6000,
        height: opts?.resizeHeight ?? 4000,
        close: () => {},
      })),
    );
    hooks.requestRepaint = vi.fn();
    resetAssets();
  });

  afterEach(() => {
    resetAssets();
    vi.unstubAllGlobals();
  });

  it("屏幕只需要 1/5 分辨率时解码 1/4 级：位图变小，宽高仍报原图，scale 记下比例", async () => {
    loadAssets({ "assets/big.png": pngOf(6000, 4000, 1) });
    expect(imageFor("big", 0.2)).toBeNull();
    await vi.waitFor(() => expect(imageFor("big", 0.2)).not.toBeNull());
    const image = imageFor("big", 0.2)!;
    expect(image).toMatchObject({ width: 6000, height: 4000, scale: 0.25 });
    expect(bitmapOptions(0)).toMatchObject({ resizeWidth: 1500, resizeHeight: 1000 });
  });

  it("需要原图（导出）时不降采样；放大后先用粗一级顶上，同时后台解原图", async () => {
    loadAssets({ "assets/big.png": pngOf(6000, 4000, 2) });
    imageFor("big", 0.2);
    await vi.waitFor(() => expect(imageFor("big", 0.2)).not.toBeNull());
    // 放大到需要原图：先拿到 1/4 级，不闪占位
    expect(imageFor("big", 1)?.scale).toBe(0.25);
    await vi.waitFor(() => expect(imageFor("big", 1)?.scale).toBeUndefined());
    const full = await ensureAssetDecoded("big");
    expect(full).toMatchObject({ width: 6000, height: 4000 });
    expect(full?.scale).toBeUndefined();
  });

  it("缓存里已有更清晰的级别时直接用，不再后台解更粗的一级", async () => {
    loadAssets({ "assets/big.png": pngOf(6000, 4000, 7) });
    await ensureAssetDecoded("big");
    const calls = vi.mocked(createImageBitmap).mock.calls.length;
    expect(imageFor("big", 0.1)?.scale).toBeUndefined();
    await Promise.resolve();
    expect(vi.mocked(createImageBitmap).mock.calls.length).toBe(calls);
  });

  it("淘汰按最近使用：刚画过的图不会因为别的图解码被挤掉", async () => {
    // 每张原图解码后 6000×4000×4 = 96 MB；预算 256 MB 只放得下两张
    loadAssets({ "assets/a.png": pngOf(6000, 4000, 3), "assets/b.png": pngOf(6000, 4000, 4), "assets/c.png": pngOf(6000, 4000, 5) });
    await ensureAssetDecoded("a");
    await ensureAssetDecoded("b");
    expect(imageFor("a")).not.toBeNull(); // 使用 a：a 变成最近使用
    await ensureAssetDecoded("c"); // 超预算：该淘汰的是 b
    const calls = vi.mocked(createImageBitmap).mock.calls.length;
    expect(imageFor("a")).not.toBeNull();
    expect(vi.mocked(createImageBitmap).mock.calls.length).toBe(calls);
    expect(imageFor("b")).toBeNull();
  });

  it("小图不分级：降采样后长边不足 256 像素时用原图", async () => {
    loadAssets({ "assets/small.png": pngOf(400, 300, 6) });
    imageFor("small", 0.1);
    await vi.waitFor(() => expect(imageFor("small", 0.1)).not.toBeNull());
    expect(bitmapOptions(0)?.resizeWidth).toBeUndefined();
  });
});
