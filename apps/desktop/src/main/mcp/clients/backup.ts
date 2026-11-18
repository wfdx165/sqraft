/**
 * 写前备份：`userData/mcp-backups/<client>-<时间戳>-<文件名>`。
 *
 * 只保留最近 5 份（每客户端），权限 0600。备份失败必须让调用方放弃写入——
 * 没有退路的改写不在 ADR-0036 的允许范围内。
 */
import { chmod, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { McpClientId } from "../../../shared/mcp-clients";
import { pathExists, statOrNull } from "./fs";

export const BACKUP_RETENTION = 5;

export const BACKUP_DIRNAME = "mcp-backups";

export interface BackupOptions {
  source: string;
  backupDir: string;
  client: McpClientId;
  /** 测试注入固定时间；默认 Date.now() */
  now?: number;
}

/** 备份成功返回路径；源文件不存在返回 null（没有东西可备份）。 */
export async function backupClientConfig(options: BackupOptions): Promise<string | null> {
  const source = await statOrNull(options.source);
  if (!source) return null;
  await mkdir(options.backupDir, { recursive: true });
  const stamp = options.now ?? Date.now();
  const base = basename(options.source);
  let target = join(options.backupDir, `${options.client}-${stamp}-${base}`);
  for (let seq = 1; await pathExists(target); seq += 1) {
    target = join(options.backupDir, `${options.client}-${stamp}-${seq}-${base}`);
  }
  await copyFile(options.source, target);
  await chmod(target, 0o600).catch(() => {});
  await pruneBackups(options.backupDir, options.client);
  return target;
}

/** 只清本客户端的备份；按文件名降序（时间戳在前）保留最近 N 份。 */
export async function pruneBackups(
  backupDir: string,
  client: McpClientId,
  keep = BACKUP_RETENTION,
): Promise<void> {
  const prefix = `${client}-`;
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch {
    return;
  }
  const mine = names.filter((name) => name.startsWith(prefix)).sort().reverse();
  await Promise.all(mine.slice(keep).map((name) => rm(join(backupDir, name), { force: true })));
}
