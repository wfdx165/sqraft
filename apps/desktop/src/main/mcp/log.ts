/**
 * 操作日志：同时写终端（info/warn → stdout，error → stderr）与
 * `app.getPath("logs")/sqraft.log`（见 `../log-file.ts`），不碰 `console`。
 *
 * 目标是"出问题时能还原一次调用"：谁调的、调了什么、成没成、多久、参数长什么样。
 * 因此格式与截断规则必须只有一份实现——埋点处只给事件与字段，别自己拼字符串。
 * 打包版从 Finder 启动时 stdout 没有出口，文件日志是唯一的现场。
 *
 * 所有进入日志的字符串（事件文本、连接身份、参数）都过 `singleLine`：
 * 压平换行、把控制字符转义成 `\uXXXX`。客户端自报的 `name` 与工具名都是不可信输入，
 * 不能让它们伪造日志行或把转义序列送进读日志的终端。
 */

import { writeLogLine } from "../log-file";

export type McpLogLevel = "info" | "warn" | "error";

/** 日志来源：MCP 流量、主进程事件、渲染层上报。行首据此区分。 */
export type LogScope = "mcp" | "app" | "renderer";

/** 整行上限：超了整体截断，保证一个事件永远只占一行。 */
export const LINE_LIMIT = 1024;
/** 普通字符串（文案、节点名）保留的字符数。 */
export const STRING_LIMIT = 200;
/** agent 传的参数结构不可控：限制嵌套层数与数组长度，别让日志爆掉。 */
const DEPTH_LIMIT = 4;
const ARRAY_LIMIT = 50;
/** 超过这个长度的纯 base64（无 `data:` 前缀）按图片体积记，别把几 MB 冲进终端。 */
const BASE64_FOLD_MIN = 1000;

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,/;
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

/** 压平换行 + 转义控制字符（含 ESC 与 C1）：一行一个事件，内容不能操纵终端。 */
export function singleLine(value: string): string {
  return value
    .replace(/\r\n?/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** 按码点截断（不会切出半个 emoji），计数口径也是码点。 */
function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const points = Array.from(value);
  if (points.length <= limit) return value;
  return `${points.slice(0, limit).join("")}…(+${points.length - limit} chars)`;
}

/** `data:image/png;base64,…` → `[image png ~423KB]`：体积是唯一有用的信息。 */
function summarizeDataUrl(match: RegExpExecArray, payload: string): string {
  const subtype = match[1].split("/")[1] ?? match[1];
  return `[image ${subtype} ~${formatBytes(base64Bytes(payload.length))}]`;
}

function base64Bytes(length: number): number {
  return Math.floor((length * 3) / 4);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 单行化 + 图片/裸 base64 折叠 + 截断。 */
export function summarizeString(value: string): string {
  const flat = singleLine(value);
  const data = DATA_URL.exec(flat);
  if (data) return summarizeDataUrl(data, flat.slice(data[0].length));
  // `create_node` 的 image 是不带 data: 前缀的裸 base64：体积比前 200 个字符有用
  if (flat.length >= BASE64_FOLD_MIN && BASE64_ONLY.test(flat)) {
    return `[base64 ~${formatBytes(base64Bytes(flat.length))}]`;
  }
  return truncate(flat, STRING_LIMIT);
}

/** 递归裁剪参数结构；超出层数/长度用占位符表示，不吞掉"有内容"这个事实。 */
export function summarize(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return summarizeString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= DEPTH_LIMIT) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) {
    const head = value.slice(0, ARRAY_LIMIT).map((item) => summarize(item, depth + 1));
    return value.length > ARRAY_LIMIT ? [...head, `…(+${value.length - ARRAY_LIMIT} items)`] : head;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = summarize(item, depth + 1);
  }
  return out;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return summarizeString(value);
  return JSON.stringify(summarize(value)) ?? String(value);
}

export function formatFields(fields?: Record<string, unknown>): string {
  if (!fields) return "";
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
}

/** 本地时间戳 `YYYY-MM-DD HH:mm:ss.SSS`：文件会跨天，日期不能省。 */
export function formatStamp(date: Date): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  return `${day} ${clock}`;
}

/** `[mcp] 2026-11-02 14:03:11.482 info  c1 claude-code/2.1 tools/call document.write ok 12ms args={…}` */
export function formatLine(
  level: McpLogLevel,
  date: Date,
  tag: string | null,
  message: string,
  fields?: Record<string, unknown>,
  scope: LogScope = "mcp",
): string {
  const head = `[${scope}] ${formatStamp(date)} ${level.padEnd(5)}${tag ? ` ${singleLine(tag)}` : ""} ${singleLine(message)}`;
  const tail = formatFields(fields);
  return truncate(tail ? `${head} ${tail}` : head, LINE_LIMIT);
}

export type McpLogSink = (level: McpLogLevel, line: string) => void;

/** 默认 sink：终端 + 文件（文件写失败自动降级，见 log-file.ts）。 */
const streamSink: McpLogSink = (level, line) => {
  const stream = level === "error" ? process.stderr : process.stdout;
  stream?.write(`${line}\n`);
  writeLogLine(line);
};

let sink: McpLogSink = streamSink;

/** 测试缝：替换写入口（传 null 恢复默认）。生产代码不要调用。 */
export function setMcpLogSink(next: McpLogSink | null): void {
  sink = next ?? streamSink;
}

export function logEvent(
  level: McpLogLevel,
  tag: string | null,
  message: string,
  fields?: Record<string, unknown>,
  scope: LogScope = "mcp",
): void {
  sink(level, formatLine(level, new Date(), tag, message, fields, scope));
}

/** 主进程事件（应用生命周期、文件 IPC、对话框）。 */
export function logApp(
  level: McpLogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  logEvent(level, null, message, fields, "app");
}

/** 渲染层上报（快捷键分发、保存链路、未捕获错误）。 */
export function logRenderer(
  level: McpLogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  logEvent(level, null, message, fields, "renderer");
}

export function logInfo(tag: string | null, message: string, fields?: Record<string, unknown>): void {
  logEvent("info", tag, message, fields);
}

export function logWarn(tag: string | null, message: string, fields?: Record<string, unknown>): void {
  logEvent("warn", tag, message, fields);
}

export function logError(tag: string | null, message: string, fields?: Record<string, unknown>): void {
  logEvent("error", tag, message, fields);
}
