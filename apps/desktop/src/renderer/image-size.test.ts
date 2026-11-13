import { describe, expect, it } from "vitest";
import { imageDimensions } from "./image-size";

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

/** 最小 JPEG：SOI + 可选 EXIF(APP1, 只含方向) + SOF0。 */
function jpeg(width: number, height: number, orientation?: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation) {
    // APP1: "Exif\0\0" + TIFF 头(II) + IFD0 一项（0x0112 方向）
    const tiff = [0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    parts.push(0xff, 0xe1, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body);
  }
  parts.push(0xff, 0xc0, 0, 17, 8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3, ...new Array(9).fill(0));
  return new Uint8Array(parts);
}

describe("读文件头拿图片尺寸", () => {
  it("PNG / GIF", () => {
    expect(imageDimensions(png(6000, 4004), "image/png")).toEqual({ width: 6000, height: 4004 });
    const gif = new Uint8Array([...new TextEncoder().encode("GIF89a"), 0x40, 0x01, 0xf0, 0x00]);
    expect(imageDimensions(gif, "image/gif")).toEqual({ width: 320, height: 240 });
  });

  it("JPEG：取 SOF 尺寸，EXIF 方向 5–8 时宽高互换", () => {
    expect(imageDimensions(jpeg(4000, 3000), "image/jpeg")).toEqual({ width: 4000, height: 3000 });
    expect(imageDimensions(jpeg(4000, 3000, 1), "image/jpeg")).toEqual({ width: 4000, height: 3000 });
    expect(imageDimensions(jpeg(4000, 3000, 6), "image/jpeg")).toEqual({ width: 3000, height: 4000 });
  });

  it("WebP（VP8X 扩展格式）", () => {
    const b = new Uint8Array(30);
    b.set(new TextEncoder().encode("RIFF"), 0);
    b.set(new TextEncoder().encode("WEBPVP8X"), 8);
    // 宽高各 24 位、存的是"减 1"
    b.set([0x7f, 0x07, 0x00, 0x37, 0x04, 0x00], 24);
    expect(imageDimensions(b, "image/webp")).toEqual({ width: 1920, height: 1080 });
  });

  it("认不出或截断时返回 null（调用方退回整图解码）", () => {
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).toBeNull();
    expect(imageDimensions(new Uint8Array(4), "image/png")).toBeNull();
    expect(imageDimensions(new Uint8Array(10), "image/svg+xml")).toBeNull();
  });
});
