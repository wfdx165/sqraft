/**
 * 文件落盘的最小原语。刻意不依赖 Electron：只在 Node 下用临时目录即可测试。
 * `.sqraft` 的内部结构（zip / 版本迁移）由渲染层负责，这里只搬字节。
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface FileSnapshot {
  path: string;
  name: string;
  mtimeMs: number;
  bytes: Uint8Array;
}

/** 读取文件并记下时间戳；读取失败时抛出带可读信息的错误。 */
export async function readFileSnapshot(path: string): Promise<FileSnapshot> {
  const bytes = await readFile(path);
  const info = await stat(path);
  return { path, name: basename(path), mtimeMs: info.mtimeMs, bytes: new Uint8Array(bytes) };
}

/** 取当前 mtime；文件不存在时返回 null（保存时视为无冲突）。 */
export async function mtimeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.mtimeMs;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * 判断磁盘上的文件是否在"上次读写"之后被外部改动过。
 * 时间戳按毫秒取整比较，避免不同文件系统的浮点误差。
 */
export function mtimeChanged(expected: number | null, current: number | null): boolean {
  if (expected === null || current === null) return false;
  return Math.round(expected) !== Math.round(current);
}

/**
 * 判断两个路径是否指向同一个文件（另存为时防止两个标签共用一个文件）。
 * macOS / Windows 的默认文件系统大小写不敏感，按小写比较；Linux 保持原样。
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalize = (path: string): string => {
    const absolute = resolve(path);
    return platform === "win32" || platform === "darwin" ? absolute.toLowerCase() : absolute;
  };
  return normalize(a) === normalize(b);
}

/**
 * 原子写：先写同目录下的临时文件，再 rename 覆盖目标。
 * rename 在同一文件系统内是原子的，因此不会出现"写了一半"的目标文件。
 * 临时文件名带自增序号：同一路径并发保存（例如窗口拖动防抖 + 关闭时补一次）时，
 * 两个调用不能共用一个临时文件，否则先完成的 rename 会让后一个 ENOENT。
 *
 * 同一路径的写入按调用顺序串行：目标文件只保留最后一次调用的内容，
 * 不会出现"先发起的写更慢、后发起的写被它覆盖"。不同路径仍互不阻塞。
 */
let tempSeq = 0;

/** 每个目标路径当前排队的队尾（只用于排序，不携带结果） */
const writeQueues = new Map<string, Promise<void>>();

export async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<number> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  // 前一次失败也要继续写：失败由各自的调用方处理，不能卡死后面的保存
  const run = previous.then(
    () => writeAtomicOnce(path, bytes),
    () => writeAtomicOnce(path, bytes),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(path, tail);
  void tail.then(() => {
    if (writeQueues.get(path) === tail) writeQueues.delete(path);
  });
  return run;
}

async function writeAtomicOnce(path: string, bytes: Uint8Array): Promise<number> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.${basename(path)}.${process.pid}.${++tempSeq}.tmp`);
  try {
    await writeFile(temp, bytes);
    await renameOverwrite(temp, path);
    const info = await stat(path);
    return info.mtimeMs;
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Windows 的 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` 在目标正被另一次 rename 替换的
 * 瞬间会返回 ERROR_ACCESS_DENIED（映射成 EPERM），于是并发保存同一路径会随机失败——
 * 这不是真的没有权限，短暂退避后重试即可。只在 win32 上对这几个"瞬时"码重试，
 * 其余错误（以及 POSIX 上的 EACCES 等真权限问题）立刻抛出，不掩盖问题。
 */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80];

async function renameOverwrite(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientRenameError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as { code?: string }).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
