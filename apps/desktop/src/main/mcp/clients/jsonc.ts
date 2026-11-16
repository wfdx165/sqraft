/**
 * JSONC 的解析与「只改自己那条」的范围编辑。
 *
 * 为什么不用 JSON.parse + 整体重写：Zed / VS Code 的配置带注释，重写会把用户注释删掉；
 * 这里用 jsonc-parser 的 `modify` + `applyEdits`，只替换目标属性的文本范围。
 */
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export type JsoncErrorCode = "CONFIG_UNPARSABLE" | "CONFIG_UNEXPECTED_SHAPE";

export type JsoncResult<T> = { ok: true; value: T } | { ok: false; code: JsoncErrorCode; detail: string };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 解析并确认根是对象；注释与尾逗号允许。 */
export function parseConfig(text: string): JsoncResult<Record<string, unknown>> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0) {
    const first = errors[0]!;
    return {
      ok: false,
      code: "CONFIG_UNPARSABLE",
      detail: `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    };
  }
  if (!isPlainObject(value)) {
    return { ok: false, code: "CONFIG_UNEXPECTED_SHAPE", detail: "root is not an object" };
  }
  return { ok: true, value };
}

/** 读路径上的值；中间缺一段就返回 undefined。 */
export function valueAt(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** 写/覆盖一个属性；中间对象不存在时自动创建，存在但不是对象则拒写。 */
export function setEntry(
  text: string,
  path: readonly string[],
  value: unknown,
): JsoncResult<string> {
  const parsed = parseConfig(text);
  if (!parsed.ok) return parsed;
  const shape = checkParents(parsed.value, path);
  if (shape) return { ok: false, code: "CONFIG_UNEXPECTED_SHAPE", detail: shape };
  const edits = modify(text, [...path], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: eolOf(text) },
  });
  return { ok: true, value: applyEdits(text, edits) };
}

/** 删一个属性；本来就不存在时原文返回。 */
export function removeEntry(text: string, path: readonly string[]): JsoncResult<string> {
  const parsed = parseConfig(text);
  if (!parsed.ok) return parsed;
  const shape = checkParents(parsed.value, path);
  if (shape) return { ok: false, code: "CONFIG_UNEXPECTED_SHAPE", detail: shape };
  if (valueAt(parsed.value, path) === undefined) return { ok: true, value: text };
  const edits = modify(text, [...path], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: eolOf(text) },
  });
  return { ok: true, value: applyEdits(text, edits) };
}

/** 父级存在但不是对象（例如 `mcpServers` 是数组）→ 返回原因；正常返回 null。 */
function checkParents(root: unknown, path: readonly string[]): string | null {
  let current: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(current)) return `parent of "${key}" is not an object`;
    const next = current[key];
    if (next === undefined) return null;
    if (!isPlainObject(next)) return `"${key}" is not an object`;
    current = next;
  }
  return null;
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** 取对象里的字符串属性（entry 的 url 等）；类型不对返回 null。 */
export function stringProp(value: unknown, key: string): string | null {
  if (!isPlainObject(value)) return null;
  const next = value[key];
  return typeof next === "string" && next ? next : null;
}
