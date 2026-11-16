import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathExists, readTextIfExists, resolveWritePath, statOrNull, writeTextAtomic } from "./fs";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-fs-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("原子写", () => {
  it("新文件写成 0600", async () => {
    const dir = await tempDir();
    const file = join(dir, "config.json");
    await writeTextAtomic(file, "{}\n");
    expect(await readFile(file, "utf8")).toBe("{}\n");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("已有文件沿用原权限", async () => {
    const dir = await tempDir();
    const file = join(dir, "config.json");
    await writeFile(file, "old", { mode: 0o644 });
    await writeTextAtomic(file, "new");
    expect(await readFile(file, "utf8")).toBe("new");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o644);
  });

  it("不创建目录，目标目录缺失直接失败", async () => {
    const dir = await tempDir();
    const target = join(dir, "missing", "config.json");
    await expect(writeTextAtomic(target, "{}")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await pathExists(join(dir, "missing"))).toBe(false);
  });
});

describe("路径辅助", () => {
  it("缺失文件读作 null，权限错误不吞", async () => {
    const dir = await tempDir();
    expect(await readTextIfExists(join(dir, "missing"))).toBeNull();
    expect(await statOrNull(join(dir, "missing"))).toBeNull();
  });

  it.skipIf(process.platform === "win32")("软链解析到真实文件", async () => {
    const dir = await tempDir();
    const real = join(dir, "real.json");
    const link = join(dir, "link.json");
    await writeFile(real, "{}");
    await symlink(real, link);
    expect(await resolveWritePath(link)).toBe(await realpath(real));
    expect(await resolveWritePath(join(dir, "new.json"))).toBe(join(await realpath(dir), "new.json"));
  });

  it("父目录是软链时，新文件落到真实目录", async () => {
    if (process.platform === "win32") return;
    const dir = await tempDir();
    const realDir = join(dir, "real");
    const linkDir = join(dir, "link");
    await mkdir(realDir);
    await symlink(realDir, linkDir);
    expect(await resolveWritePath(join(linkDir, "config.json"))).toBe(join(await realpath(realDir), "config.json"));
  });
});
