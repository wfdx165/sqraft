/**
 * 文件 adapter 的最小文件层：不创建目录、原子写、按软链真实路径写、保留权限。
 *
 * 为什么不用 `main/files.ts` 的 `writeFileAtomic`：它会 `mkdir -p`，而接入的硬规则是
 * 「目标目录不存在 = 客户端没装」。这个差异必须留在代码里，不能靠调用方自觉。
 */
import { constants, type Stats } from "node:fs";
import { access, chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

let tempSeq = 0;

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** 读文本；文件不存在返回 null。权限错误、IO 错误继续抛，交给上层分类。 */
export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 目标可能是指向 dotfiles 仓库的软链：写到真实文件，链接本身保留。
 * 文件还不存在时，至少把父目录的软链解开（`~/.config` 常见）。
 */
export async function resolveWritePath(path: string): Promise<string> {
  const file = await realpath(path).catch(() => null);
  if (file) return file;
  const parent = await realpath(dirname(path)).catch(() => null);
  return parent ? join(parent, basename(path)) : path;
}

export interface AtomicWriteOptions {
  /** 新文件的权限；已存在的文件沿用原权限 */
  mode?: number;
}

/**
 * 同目录临时文件 + rename；不创建目录。
 * Windows 上目标正被别的进程持有会瞬时 EPERM/EBUSY，短暂退避重试（与保存链路同一类问题）。
 */
export async function writeTextAtomic(path: string, text: string, options: AtomicWriteOptions = {}): Promise<void> {
  const existing = await statOrNull(path);
  const mode = existing ? existing.mode & 0o777 : (options.mode ?? 0o600);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${++tempSeq}.tmp`);
  try {
    await writeFile(temp, text, { encoding: "utf8", mode });
    if (existing && process.platform !== "win32") await chmod(temp, mode);
    await renameWithRetry(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  // writeFile 的 mode 只在创建时生效；已存在文件经 rename 后权限来自临时文件，这里再兜一次
  if (existing) await chmod(path, mode).catch(() => {});
}

const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80];

async function renameWithRetry(from: string, to: string): Promise<void> {
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
