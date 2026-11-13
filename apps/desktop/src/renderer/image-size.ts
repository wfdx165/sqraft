/**
 * 不解码、只读文件头拿图片尺寸（按显示方向，即已套用 JPEG 的 EXIF 方向）。
 *
 * 用途：按需降采样解码（`createImageBitmap` 的 `resizeWidth/Height`）要先知道原图尺寸，
 * 而为了拿尺寸先整张解码一次，正是要省掉的那笔开销。认不出时返回 null，调用方退回整图解码。
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

function u16be(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}

function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
}

function u16le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}

function u24le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
}

function ascii(b: Uint8Array, i: number, n: number): string {
  return String.fromCharCode(...b.subarray(i, i + n));
}

/** JPEG 的 EXIF 方向（1–8）；没有 EXIF 时为 1。 */
function jpegOrientation(b: Uint8Array, app1: number, length: number): number {
  const start = app1 + 4;
  if (ascii(b, start, 4) !== "Exif") return 1;
  const tiff = start + 6;
  const little = ascii(b, tiff, 2) === "II";
  const r16 = (i: number) => (little ? u16le(b, i) : u16be(b, i));
  const r32 = (i: number) => (little ? (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0 : u32be(b, i));
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > app1 + 2 + length) return 1;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > b.length) break;
    if (r16(entry) === 0x0112) return r16(entry + 8);
  }
  return 1;
}

function jpegSize(b: Uint8Array): ImageDimensions | null {
  let orientation = 1;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const length = u16be(b, i + 2);
    if (marker === 0xe1) orientation = jpegOrientation(b, i, length);
    // SOF0–SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(b, i + 5);
      const width = u16be(b, i + 7);
      // 方向 5–8 = 转 90°：显示尺寸宽高互换
      return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
    }
    i += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): ImageDimensions | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

export function imageDimensions(bytes: Uint8Array, mime: string): ImageDimensions | null {
  try {
    let size: ImageDimensions | null = null;
    if (mime === "image/png" && bytes.length >= 24) size = { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    else if (mime === "image/gif" && bytes.length >= 10) size = { width: u16le(bytes, 6), height: u16le(bytes, 8) };
    else if (mime === "image/webp") size = webpSize(bytes);
    else if (mime === "image/jpeg") size = jpegSize(bytes);
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}
