/**
 * Token 路径与取值的校验规则（纯函数，不依赖 DOM）。
 *
 * 设计系统面板与 AI 工具共用同一套判定，避免两边各写一份正则后慢慢漂移。
 * 颜色只接受字面量：#hex（3/6/8 位）、rgb()、rgba()；命名色与 hsl 不收。
 */

const TOKEN_PATH = /^[^\s/]+(\/[^\s/]+)+$/;
const TOKEN_HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const TOKEN_RGB = /^rgba?\(\s*[\d.]+%?\s*[, ]\s*[\d.]+%?\s*[, ]\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i;

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
