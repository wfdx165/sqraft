/**
 * 工具入参的契约校验：JSON Schema 里显式写了 `additionalProperties: false` 的层级
 * 不接受未声明的键。
 *
 * handler 只挑自己认识的键，未知键会被静默丢掉——agent 传 `style: {...}` 会拿到
 * `{"ok":true}` 但画布没动。所以在分派前先按 schema 拦一次，只做「未知键」这一件事；
 * 类型、枚举、必填仍由各 handler 自己校验。
 */

type JsonSchema = Record<string, unknown>;

interface UnknownArg {
  /** 参数路径：顶层是 `style`，嵌套是 `nodes[0].style`、`effects[0].foo`。 */
  path: string;
  /** 该层级允许的键（用来提示 agent 改哪个字段）。 */
  available: string[];
}

/** 错误里最多列多少个可用键，避免一条报错刷屏。 */
const MAX_AVAILABLE = 20;

function isSchema(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** `type` 与值的 JS 类型是否相容；没写 `type`（或写了不认识的类型）按宽松处理。 */
function matchesType(type: unknown, value: unknown): boolean {
  if (type === undefined) return true;
  const list = Array.isArray(type) ? type : [type];
  return list.some((item) => {
    switch (item) {
      case "object":
        return isPlainObject(value);
      case "array":
        return Array.isArray(value);
      case "string":
        return typeof value === "string";
      case "number":
      case "integer":
        return typeof value === "number";
      case "boolean":
        return typeof value === "boolean";
      case "null":
        return value === null;
      default:
        return true;
    }
  });
}

/** 分支是否适用于这个值（解一层 `$ref` 再看 `type`），用来在单向联合里挑候选。 */
function appliesTo(root: JsonSchema, schema: JsonSchema, value: unknown): boolean {
  if (typeof schema.$ref === "string") {
    const target = resolveRef(root, schema.$ref);
    return target ? matchesType(target.type, value) : true;
  }
  return matchesType(schema.type, value);
}

/** 解析工具 schema 内部的本地引用（`#/$defs/…`）；外部引用不追，交给宽松处理。 */
function resolveRef(root: JsonSchema, ref: string): JsonSchema | null {
  if (!ref.startsWith("#/")) return null;
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    if (!isSchema(current)) return null;
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current[key];
  }
  return isSchema(current) ? current : null;
}

/**
 * 收集一处值里所有未声明的键。
 *
 * - `oneOf` / `anyOf`：取「未知键最少」的分支结果；有任一分支完全通过就算通过
 *   （判别式联合里各分支的字段互不相干，不能把别的分支的键当未知）。
 * - `allOf`：所有分支都必须成立，结果取并集。
 * - 数组只看 `items`，对象只看 `properties`。
 */
function collectUnknown(root: JsonSchema, schema: JsonSchema, value: unknown, path: string): UnknownArg[] {
  if (typeof schema.$ref === "string") {
    const target = resolveRef(root, schema.$ref);
    return target ? collectUnknown(root, target, value, path) : [];
  }

  // 类型不相容时这层不适用：值本身对不对是 handler 的事，这里只找未知键
  if (!matchesType(schema.type, value)) return [];

  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null;
  if (alternatives) {
    const schemas = alternatives.filter(isSchema);
    // 只和类型相容的分支比；都说不清时退回全部，避免漏报
    const applicable = schemas.filter((branch) => appliesTo(root, branch, value));
    const candidates = applicable.length > 0 ? applicable : schemas;
    let best: UnknownArg[] | null = null;
    for (const branch of candidates) {
      const found = collectUnknown(root, branch, value, path);
      if (found.length === 0) return [];
      if (!best || found.length < best.length) best = found;
    }
    return best ?? [];
  }

  if (Array.isArray(schema.allOf)) {
    return schema.allOf.flatMap((branch) =>
      isSchema(branch) ? collectUnknown(root, branch, value, path) : [],
    );
  }

  if (Array.isArray(value)) {
    const items = schema.items;
    if (!isSchema(items)) return [];
    return value.flatMap((item, index) =>
      collectUnknown(root, items, item, `${path}[${index}]`),
    );
  }

  if (!isPlainObject(value)) return [];

  const properties = isSchema(schema.properties) ? schema.properties : {};
  const known = Object.keys(properties);
  const found: UnknownArg[] = [];

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        found.push({ path: path ? `${path}.${key}` : key, available: known });
      }
    }
  }

  for (const key of known) {
    if (!(key in value)) continue;
    const child = properties[key];
    if (!isSchema(child)) continue;
    found.push(...collectUnknown(root, child, value[key], path ? `${path}.${key}` : key));
  }
  return found;
}

function describeUnknown(arg: UnknownArg): string {
  if (arg.available.length === 0) return `"${arg.path}"（该层不接受任何参数）`;
  const shown = arg.available.slice(0, MAX_AVAILABLE);
  const more = arg.available.length > shown.length ? "、…" : "";
  return `"${arg.path}"（可用参数：${shown.join("、")}${more}）`;
}

/**
 * 参数里有 schema 没声明的键就抛错，handler 不会执行、不产生撤销步、文档零改动。
 * `schema` 缺失（有 handler 没工具定义）时跳过，不在这里兜底内部不一致。
 */
export function assertKnownArgs(
  toolName: string,
  schema: JsonSchema | undefined,
  args: Record<string, unknown>,
): void {
  if (!schema || !isPlainObject(args)) return;
  const unknown = collectUnknown(schema, schema, args, "");
  if (unknown.length === 0) return;
  throw new Error(`${toolName}: 未知参数 ${unknown.map(describeUnknown).join("；")}`);
}
