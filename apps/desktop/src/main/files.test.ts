import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mtimeChanged, mtimeOf, readFileSnapshot, writeFileAtomic } from "./files";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-files-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("原子写", () => {
  it("写入新文件并返回可用的时间戳", async () => {
    const dir = await tempDir();
    const path = join(dir, "a.sqraft");
    const mtimeMs = await writeFileAtomic(path, new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([1, 2, 3]));
    expect(mtimeMs).toBeGreaterThan(0);
  });

  it("覆盖已有文件，且不留下临时文件", async () => {
    const dir = await tempDir();
    const path = join(dir, "a.sqraft");
    await writeFile(path, "old");
    await writeFileAtomic(path, new Uint8Array([9]));
    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([9]));
    expect(await readdir(dir)).toEqual(["a.sqraft"]);
  });

  it("目标目录不存在时自动创建", async () => {
    const dir = await tempDir();
    const path = join(dir, "nested", "deep", "a.sqraft");
    await writeFileAtomic(path, new Uint8Array([7]));
    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([7]));
  });

  it("rename 失败时清掉临时文件", async () => {
    const dir = await tempDir();
    // 目标是一个非空目录：rename 到目录会失败
    const path = join(dir, "target");
    await writeFileAtomic(join(path, "keep.txt"), new Uint8Array([1]));
    await expect(writeFileAtomic(path, new Uint8Array([2]))).rejects.toBeTruthy();
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("同一路径并发写不会互相踩临时文件", async () => {
    const dir = await tempDir();
    const path = join(dir, "preferences.json");
    await Promise.all([
      writeFileAtomic(path, new TextEncoder().encode("a")),
      writeFileAtomic(path, new TextEncoder().encode("b")),
      writeFileAtomic(path, new TextEncoder().encode("c")),
    ]);
    expect(["a", "b", "c"]).toContain(await readFile(path, "utf8"));
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("外部修改检测", () => {
  it("缺失即视为无冲突", () => {
    expect(mtimeChanged(null, 123)).toBe(false);
    expect(mtimeChanged(123, null)).toBe(false);
  });

  it("同一时间戳按毫秒取整后相等", () => {
    expect(mtimeChanged(1700000000000.1, 1700000000000.4)).toBe(false);
  });

  it("磁盘文件被改写后能被识别", async () => {
    const dir = await tempDir();
    const path = join(dir, "a.sqraft");
    await writeFile(path, "one");
    const snapshot = await readFileSnapshot(path);
    await new Promise((resolve) => setTimeout(resolve, 12));
    await writeFile(path, "two");
    expect(mtimeChanged(snapshot.mtimeMs, await mtimeOf(path))).toBe(true);
  });

  it("读取快照带回文件名与内容", async () => {
    const dir = await tempDir();
    const path = join(dir, "设计稿.sqraft");
    await writeFile(path, "hello");
    const snapshot = await readFileSnapshot(path);
    expect(snapshot.name).toBe("设计稿.sqraft");
    expect(new TextDecoder().decode(snapshot.bytes)).toBe("hello");
    expect(snapshot.mtimeMs).toBe((await stat(path)).mtimeMs);
  });
});
