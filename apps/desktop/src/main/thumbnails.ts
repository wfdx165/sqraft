/**
 * 欢迎页「最近打开」的封面缓存。
 *
 * 封面由渲染层在保存 / 打开后画一张 480×300 的小图（当前活动页），主进程只负责
 * 按「路径 + mtime」落盘：文件被外部改过（mtime 变了）就不再命中原图，显示占位。
 *
 * 刻意不写进 `.sqraft`（格式不动，主进程也不需要理解 zip）：封面只是本机的缓存，
 * 拷走文件不会带走它；旧版保存的文件第一次打开后由渲染层补一张。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RecentEntry } from "../shared/ipc";

/** userData 下的目录名；不复用 image-cache，避免和链接图缓存混在一起。 */
export const THUMBNAIL_DIR = "thumbnails";

/** 一次列表最多给多少张：与最近列表上限（8）一致，避免扫出历史残留。 */
const MAX_THUMBS = 12;

/** 路径摘要：文件名只用来让目录里可读，碰撞概率按 128 位算可以忽略。 */
function digestOf(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 32);
}

export function thumbnailName(path: string, mtimeMs: number): string {
  return `${digestOf(path)}-${Math.round(mtimeMs)}.png`;
}

function dataUrlOf(bytes: Uint8Array): string {
  const png = bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return `data:image/${png ? "png" : "jpeg"};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** 落一张封面；空字节直接忽略（渲染失败时调用方会传 null）。 */
export async function writeThumbnail(
  dir: string,
  path: string,
  mtimeMs: number,
  bytes: Uint8Array | undefined,
): Promise<void> {
  if (!bytes || bytes.length === 0) return;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, thumbnailName(path, mtimeMs)), bytes);
}

/** 读当前 mtime 对应的封面；没有就返回 null（旧文件 / 外部改动 / 首次打开）。 */
export async function readThumbnail(dir: string, path: string, mtimeMs: number): Promise<string | null> {
  try {
    const bytes = await readFile(join(dir, thumbnailName(path, mtimeMs)));
    return dataUrlOf(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/**
 * 只保留「最近列表里、且 mtime 与文件名一致」的封面。
 * 每次写入或列取时顺手跑一次，用户不需要手动清缓存。
 */
export async function pruneThumbnails(dir: string, paths: readonly string[]): Promise<void> {
  const keep = new Set<string>();
  await Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(path);
        keep.add(thumbnailName(path, info.mtimeMs));
      } catch {
        // 文件没了：没有封面可留
      }
    }),
  );
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      if (keep.has(name)) return;
      await unlink(join(dir, name)).catch(() => undefined);
    }),
  );
}

/**
 * 最近列表 + 封面。删除与 stat 失败都按「文件不存在」回报（`mtimeMs: null`），
 * 让欢迎页把卡片置灰而不是弹错误。
 */
export async function recentEntries(dir: string, paths: readonly string[]): Promise<RecentEntry[]> {
  void pruneThumbnails(dir, paths).catch(() => undefined);
  const sliced = paths.slice(0, MAX_THUMBS);
  return Promise.all(
    sliced.map(async (path) => {
      const name = basename(path);
      try {
        const info = await stat(path);
        return { path, name, mtimeMs: info.mtimeMs, thumbnail: await readThumbnail(dir, path, info.mtimeMs) };
      } catch {
        return { path, name, mtimeMs: null, thumbnail: null };
      }
    }),
  );
}
