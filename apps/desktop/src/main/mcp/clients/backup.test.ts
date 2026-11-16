import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupClientConfig, pruneBackups } from "./backup";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-backup-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("写前备份", () => {
  it("复制原文件内容并收敛到 0600", async () => {
    const dir = await tempDir();
    const source = join(dir, "mcp.json");
    const backupDir = join(dir, "backups");
    await writeFile(source, '{"mcpServers":{}}\n', { mode: 0o644 });

    const backup = await backupClientConfig({ source, backupDir, client: "cursor", now: 1000 });
    expect(backup).toBe(join(backupDir, "cursor-1000-mcp.json"));
    expect(await readFile(backup!, "utf8")).toBe('{"mcpServers":{}}\n');
    if (process.platform !== "win32") {
      expect((await stat(backup!)).mode & 0o777).toBe(0o600);
    }
  });

  it("源文件不存在时不创建备份", async () => {
    const dir = await tempDir();
    const backupDir = join(dir, "backups");
    expect(await backupClientConfig({ source: join(dir, "missing.json"), backupDir, client: "zed" })).toBeNull();
    expect(await readdir(backupDir).catch(() => [])).toEqual([]);
  });

  it("只保留最近 5 份，且不碰其它客户端的备份", async () => {
    const dir = await tempDir();
    const source = join(dir, "config.json");
    const backupDir = join(dir, "backups");
    await writeFile(source, "{}");
    await writeFile(join(dir, "other.txt"), "x");
    await backupClientConfig({ source: join(dir, "other.txt"), backupDir, client: "zed", now: 999 });

    for (let i = 0; i < 7; i += 1) {
      await backupClientConfig({ source, backupDir, client: "cursor", now: 1000 + i });
    }
    const names = (await readdir(backupDir)).sort();
    expect(names.filter((name) => name.startsWith("cursor-"))).toEqual([
      "cursor-1002-config.json",
      "cursor-1003-config.json",
      "cursor-1004-config.json",
      "cursor-1005-config.json",
      "cursor-1006-config.json",
    ]);
    expect(names).toContain("zed-999-other.txt");
  });

  it("prune 在目录不存在时静默返回", async () => {
    const dir = await tempDir();
    await expect(pruneBackups(join(dir, "missing"), "cursor")).resolves.toBeUndefined();
  });
});
