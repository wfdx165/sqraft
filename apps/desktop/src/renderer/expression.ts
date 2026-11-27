/**
 * 数值输入的算式求值（纯函数，便于测试）。
 *
 * 支持 `+ - * / ( )` 与小数，忽略 `px` / `%` 后缀；
 * 刻意不做 `eval`、不认变量与函数——只覆盖 `1200/2`、`100+16` 这类真实需求。
 */
export function evaluateExpression(raw: string): number | null {
  const text = raw.trim().replace(/\s+/g, "").replace(/(px|%)$/i, "");
  if (!text) return null;
  if (!/^[\d.+\-*/()]+$/.test(text)) return null;

  let index = 0;

  const peek = (): string => text[index] ?? "";
  const eat = (char: string): boolean => {
    if (peek() !== char) return false;
    index += 1;
    return true;
  };

  const parseNumber = (): number | null => {
    const start = index;
    let dots = 0;
    while (/[\d.]/.test(peek())) {
      if (peek() === ".") dots += 1;
      index += 1;
    }
    if (index === start || dots > 1) return null;
    const value = Number(text.slice(start, index));
    return Number.isFinite(value) ? value : null;
  };

  const parseFactor = (): number | null => {
    if (eat("+")) return parseFactor();
    if (eat("-")) {
      const value = parseFactor();
      return value === null ? null : -value;
    }
    if (eat("(")) {
      const value = parseExpression();
      if (value === null || !eat(")")) return null;
      return value;
    }
    return parseNumber();
  };

  const parseTerm = (): number | null => {
    let value = parseFactor();
    if (value === null) return null;
    for (;;) {
      if (eat("*")) {
        const rhs = parseFactor();
        if (rhs === null) return null;
        value *= rhs;
      } else if (eat("/")) {
        const rhs = parseFactor();
        if (rhs === null || rhs === 0) return null;
        value /= rhs;
      } else {
        return value;
      }
    }
  };

  function parseExpression(): number | null {
    let value = parseTerm();
    if (value === null) return null;
    for (;;) {
      if (eat("+")) {
        const rhs = parseTerm();
        if (rhs === null) return null;
        value += rhs;
      } else if (eat("-")) {
        const rhs = parseTerm();
        if (rhs === null) return null;
        value -= rhs;
      } else {
        return value;
      }
    }
  }

  const result = parseExpression();
  if (result === null || index !== text.length || !Number.isFinite(result)) return null;
  return result;
}
