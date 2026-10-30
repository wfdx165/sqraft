/**
 * 数据目录：统一放在用户 home 下的 `~/.sqraft/`。
 *
 * 以前是 Electron 默认的 `userData`（macOS 的 `~/Library/Application Support/Sqraft`），
 * 用户找不到、也不好备份。首次启动时把旧目录里的偏好复制过来，旧目录保留不删。
 *
 * CLI（`resources/bin/sqraft-mcp`）里有一份等价的路径规则，改动时两边必须同步。
 */
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 数据根目录：`<home>/.sqraft`（Windows 同样是 home 下的点目录）。 */
export function dataDirOf(home: string): string {
  return join(home, ".sqraft");
}

/** 迁移标记：存在即表示"已经尝试过从旧目录搬迁"，避免每次启动重复复制。 */
export const MIGRATION_MARKER = ".migrated-from-userdata";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 建好数据目录，并把旧 `userData` 里的偏好搬过来（只搬一次）。
 * 返回最终的数据目录。迁移失败不阻断启动——旧数据还在原处。
 */
export async function prepareDataDir(legacyDir: string, home = homedir()): Promise<string> {
  const target = dataDirOf(home);
  await mkdir(target, { recursive: true });
  if (legacyDir === target) return target;

  const marker = join(target, MIGRATION_MARKER);
  if (await exists(marker)) return target;

  try {
    const preferences = join(legacyDir, "preferences.json");
    const migrated = join(target, "preferences.json");
    if ((await exists(preferences)) && !(await exists(migrated))) {
      await copyFile(preferences, migrated);
    }
    await writeFile(marker, new Date().toISOString(), "utf8");
  } catch {
    // 迁移失败就算了：偏好丢失不影响使用，旧目录原样保留
  }
  return target;
}
