/**
 * 文件落盘的最小原语。刻意不依赖 Electron：只在 Node 下用临时目录即可测试。
 * `.sqraft` 的内部结构（zip / 版本迁移）由渲染层负责，这里只搬字节。
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
 * 原子写：先写同目录下的临时文件，再 rename 覆盖目标。
 * rename 在同一文件系统内是原子的，因此不会出现"写了一半"的目标文件。
 * 临时文件名带自增序号：同一路径并发保存（例如窗口拖动防抖 + 关闭时补一次）时，
 * 两个调用不能共用一个临时文件，否则先完成的 rename 会让后一个 ENOENT。
 */
let tempSeq = 0;

export async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<number> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.${basename(path)}.${process.pid}.${++tempSeq}.tmp`);
  try {
    await writeFile(temp, bytes);
    await rename(temp, path);
    const info = await stat(path);
    return info.mtimeMs;
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
