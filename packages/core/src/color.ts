/**
 * 颜色解析与色距（纯函数，不碰 DOM——core 必须能在 Node 下完整测试）。
 *
 * 色距用 **OKLab** 的欧氏距离（ADR-0035）：感知均匀。
 * 用 sRGB 欧氏距离排序会把 `#000000` 与 `#333333` 判得比 `#000000` 与 `#0000ff` 更远，
 * 给 agent 的"最接近 Token"就会排错。
 */

/** sRGB 分量，0–1。 */
type RGB = [number, number, number];

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function hexPair(pair: string): number {
  return parseInt(pair, 16) / 255;
}

/**
 * 解析颜色字面量为 sRGB 分量。只收 `tokenColorOf()` 认的那几种：
 * `#abc` / `#aabbcc` / `#aabbccdd`、`rgb()` / `rgba()`（数值或百分比、逗号或空格分隔）。
 * 命名色与 `hsl()` 返回 null——它们本来也不在 Token 的合法取值里。
 */
export function parseColor(value: unknown): RGB | null {
  const raw = String(value ?? "").trim();
  if (raw.startsWith("#")) {
    const hex = raw.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b] = [...hex.slice(0, 3)].map((c) => hexPair(c + c));
      return [r, g, b];
    }
    if (hex.length === 6 || hex.length === 8) {
      return [hexPair(hex.slice(0, 2)), hexPair(hex.slice(2, 4)), hexPair(hex.slice(4, 6))];
    }
    return null;
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(raw);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean).slice(0, 3);
    if (parts.length < 3) return null;
    const nums = parts.map((p) =>
      p.endsWith("%") ? Number.parseFloat(p) / 100 : Number.parseFloat(p) / 255,
    );
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return [clamp01(nums[0]), clamp01(nums[1]), clamp01(nums[2])];
  }
  return null;
}

/** sRGB → 线性光。 */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 线性光 → OKLab（Björn Ottosson 的矩阵）。 */
function toOklab([r, g, b]: RGB): [number, number, number] {
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/**
 * 两个颜色字面量的 OKLab 色距（0 ≈ 同色，60+ ≈ 明显不同）。
 * 任一侧解析不出来返回 null——调用方据此决定"不给距离"而不是"排在最后"。
 */
export function colorDistance(a: unknown, b: unknown): number | null {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  const [l1, a1, b1] = toOklab(ca);
  const [l2, a2, b2] = toOklab(cb);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}
