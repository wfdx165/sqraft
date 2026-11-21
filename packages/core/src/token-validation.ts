/**
 * Token 路径与取值的校验规则（纯函数，不依赖 DOM）。
 *
 * 设计系统面板与 AI 工具共用同一套判定，避免两边各写一份正则后慢慢漂移。
 * 颜色只接受字面量：#hex（3/6/8 位）、rgb()、rgba()；命名色与 hsl 不收。
 */

import { isGradientValue, type GradientStop, type GradientValue, type SolidPaint } from "./model";

const TOKEN_PATH = /^[^\s/]+(\/[^\s/]+)+$/;
const TOKEN_HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const TOKEN_RGB = /^rgba?\(\s*[\d.]+%?\s*[, ]\s*[\d.]+%?\s*[, ]\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i;

/** 渐变色标上限：与检查器一致，超过就不是"渐变"而是噪声。 */
export const MAX_GRADIENT_STOPS = 16;

/** 合法的 Token 路径（去首尾空格后至少两段）；不合法返回 null。 */
export function tokenPathOf(value: unknown): string | null {
  const path = String(value ?? "").trim();
  return TOKEN_PATH.test(path) ? path : null;
}

/** 合法的颜色字面量（去首尾空格）；不合法返回 null。 */
export function tokenColorOf(value: unknown): string | null {
  const color = String(value ?? "").trim();
  return TOKEN_HEX.test(color) || TOKEN_RGB.test(color) ? color : null;
}

/** 合法的数值（number 或非空数字字符串，必须是有限值）；不合法返回 null。 */
export function tokenNumberOf(value: unknown): number | null {
  const number =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

/** 色标里的颜色：Token 引用优先，否则必须是合法颜色字面量。 */
function stopColorOf(value: unknown): SolidPaint | null {
  if (!value || typeof value !== "object") return null;
  const paint = value as { token?: unknown; value?: unknown };
  const token = paint.token === undefined ? null : tokenPathOf(paint.token);
  if (token) return { token };
  const color = tokenColorOf(paint.value);
  return color ? { value: color } : null;
}

/**
 * 合法的渐变值（ADR-0039）：2–16 个色标，offset 夹到 0–1 并升序保存。
 * 任何一个色标不合法就整体拒绝——静默丢色标会让用户看到"颜色变了"。
 */
export function tokenGradientOf(value: unknown): GradientValue | null {
  if (!isGradientValue(value)) return null;
  if (value.stops.length < 2 || value.stops.length > MAX_GRADIENT_STOPS) return null;
  const stops: GradientStop[] = [];
  for (const stop of value.stops) {
    if (!stop || typeof stop.offset !== "number" || !Number.isFinite(stop.offset)) return null;
    const color = stopColorOf(stop.color);
    if (!color) return null;
    stops.push({ offset: Math.min(1, Math.max(0, stop.offset)), color });
  }
  stops.sort((a, b) => a.offset - b.offset);
  return {
    type: value.type,
    from: { x: value.from.x, y: value.from.y },
    to: { x: value.to.x, y: value.to.y },
    ...(value.focus ? { focus: { x: value.focus.x, y: value.focus.y } } : {}),
    stops,
  };
}
