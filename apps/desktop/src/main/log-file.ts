/**
 * 日志落盘：`~/.sqraft/logs/sqraft.log`，按大小轮转。
 *
 * 为什么要有它：打包版从 Finder 启动时 stdout 没有出口，保存失败这类只在
 * 安装包里复现的问题看不到任何现场。日志同时写终端与文件，dev / 打包版一致。
 *
 * 边界：
 * - 只由一个模块写，格式由 `mcp/log.ts` 统一生成，这里只负责追加与轮转；
 * - 任何写盘错误都静默降级（关掉文件输出、终端照旧），日志不能影响业务；
 * - 同步追加：单行上限 1KB，代价可忽略，换来崩溃前最后一行也一定落盘。
 *   不要改成缓冲写——排障要的正是崩溃前最后几行；
 * - 多进程（dev 实例 + 打包版同时运行）会写同一个文件：追加是 O_APPEND，单行不会互相截断；
 *   轮转的 rename 没有跨进程互斥，极端情况下会少一代归档，或让其中一个进程降级为仅终端。
 *   日志是旁路，接受这个代价。
 */
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const LOG_FILE_NAME = "sqraft.log";
/** 单文件上限：写满后轮转。 */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** 保留的文件总数（含当前文件）：`sqraft.log` + `.1` … `.9`。 */
export const DEFAULT_MAX_FILES = 10;

export interface LogFileOptions {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
}

/** 归一化后的运行参数（默认值已填好）。 */
interface ActiveLogFile {
  dir: string;
  maxBytes: number;
  maxFiles: number;
}

let options: ActiveLogFile | null = null;
/** 初始化成功（目录可写）才为 true：失败时菜单不该指向一个不存在的目录。 */
let ready = false;
/** 当前文件已写字节数：init 时取一次 stat，之后按写入累加，避免每行都 stat。 */
let currentBytes = 0;
let disabled = false;
let warned = false;

function archiveName(index: number): string {
  return `${LOG_FILE_NAME}.${index}`;
}

function archiveIndex(name: string): number | null {
  if (!name.startsWith(`${LOG_FILE_NAME}.`)) return null;
  const suffix = name.slice(LOG_FILE_NAME.length + 1);
  return /^\d+$/.test(suffix) ? Number(suffix) : null;
}

function fail(error: unknown): void {
  disabled = true;
  ready = false;
  if (warned) return;
  warned = true;
  // 只报一次，且不走日志器（避免递归）；打包版无 stdout 时自然丢弃
  process.stderr?.write(`[log] file logging disabled: ${error instanceof Error ? error.message : String(error)}\n`);
}

/** 启动时初始化：建目录、清掉超量归档、读出当前文件体积。可重复调用（测试/改目录）。 */
export function initLogFile(next: LogFileOptions): void {
  options = {
    dir: next.dir,
    maxBytes: next.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: Math.max(2, next.maxFiles ?? DEFAULT_MAX_FILES),
  };
  disabled = false;
  warned = false;
  ready = false;
  currentBytes = 0;
  try {
    mkdirSync(options.dir, { recursive: true });
    pruneArchives(options.dir, options.maxFiles);
    currentBytes = sizeOf(join(options.dir, LOG_FILE_NAME));
    ready = true;
  } catch (error) {
    fail(error);
  }
}

/** 日志目录：未初始化或初始化失败时为 null（菜单与排障提示用）。 */
export function logFileDir(): string | null {
  return ready ? options?.dir ?? null : null;
}

export function logFilePath(): string | null {
  return ready && options ? join(options.dir, LOG_FILE_NAME) : null;
}

/** 追加一行（不含换行）。未初始化、已降级或写失败时什么都不做。 */
export function writeLogLine(line: string): void {
  if (!options || disabled) return;
  try {
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (currentBytes + bytes > options.maxBytes) rotate(options);
    appendFileSync(join(options.dir, LOG_FILE_NAME), `${line}\n`, "utf8");
    currentBytes += bytes;
  } catch (error) {
    fail(error);
  }
}

/** 测试用：把模块恢复到未初始化状态。 */
export function resetLogFile(): void {
  options = null;
  ready = false;
  currentBytes = 0;
  disabled = false;
  warned = false;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0; // 还没写过
  }
}

/** 只保留 1 … maxFiles-1 号归档；启动时清掉滚出窗口的旧文件。 */
function pruneArchives(dir: string, maxFiles: number): void {
  for (const name of readdirSync(dir)) {
    const index = archiveIndex(name);
    if (index === null || index < maxFiles) continue;
    rmSync(join(dir, name), { force: true });
  }
}

/** 当前文件 → `.1`，旧的 `.n` → `.n+1`，最后一档直接删掉。 */
function rotate(current: { dir: string; maxFiles: number }): void {
  const dir = current.dir;
  const last = current.maxFiles - 1;
  rmSync(join(dir, archiveName(last)), { force: true });
  for (let index = last - 1; index >= 1; index -= 1) {
    const from = join(dir, archiveName(index));
    if (!exists(from)) continue;
    renameSync(from, join(dir, archiveName(index + 1)));
  }
  if (exists(join(dir, LOG_FILE_NAME))) renameSync(join(dir, LOG_FILE_NAME), join(dir, archiveName(1)));
  currentBytes = 0;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
