import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneThumbnails, readThumbnail, recentEntries, thumbnailName, writeThumbnail } from "./thumbnails";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-thumbs-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe("欢迎页封面缓存", () => {
  it("按路径与 mtime 落盘，读回 data URL", async () => {
    const dir = await tempDir();
    await writeThumbnail(dir, "/docs/a.sqraft", 1000, PNG);
    const url = await readThumbnail(dir, "/docs/a.sqraft", 1000);
    expect(url).toMatch(/^data:image\/png;base64,/);
    // mtime 变了就当作没缓存（文件被外部改过）
    expect(await readThumbnail(dir, "/docs/a.sqraft", 1001)).toBeNull();
    // 另一个路径也不会命中
    expect(await readThumbnail(dir, "/docs/b.sqraft", 1000)).toBeNull();
  });

  it("JPEG 字节给出 image/jpeg 的 data URL", async () => {
    const dir = await tempDir();
    await writeThumbnail(dir, "/docs/a.sqraft", 1000, JPEG);
    expect(await readThumbnail(dir, "/docs/a.sqraft", 1000)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("空字节不写文件", async () => {
    const dir = await tempDir();
    await writeThumbnail(dir, "/docs/a.sqraft", 1000, new Uint8Array(0));
    expect(await readdir(dir)).toEqual([]);
  });

  it("清理只留下最近列表里、且 mtime 对得上的那张", async () => {
    const dir = await tempDir();
    const docs = await tempDir();
    const a = join(docs, "a.sqraft");
    const b = join(docs, "b.sqraft");
    await writeFile(a, "a");
    await writeFile(b, "b");

    const aMtime = (await stat(a)).mtimeMs;
    const bMtime = (await stat(b)).mtimeMs;
    await writeThumbnail(dir, a, aMtime, PNG);
    await writeThumbnail(dir, b, bMtime, PNG);
    await writeThumbnail(dir, a, aMtime + 5000, PNG); // 旧 mtime 的残留

    await pruneThumbnails(dir, [a]);
    expect((await readdir(dir)).sort()).toEqual([thumbnailName(a, aMtime)]);
  });

  it("列表：存在的文件给 mtime 与封面，删掉的文件标 null", async () => {
    const dir = await tempDir();
    const docs = await tempDir();
    const a = join(docs, "a.sqraft");
    await writeFile(a, "a");
    const mtime = (await stat(a)).mtimeMs;
    await writeThumbnail(dir, a, mtime, PNG);

    const entries = await recentEntries(dir, [a, join(docs, "missing.sqraft")]);
    expect(entries[0]).toMatchObject({ name: "a.sqraft", mtimeMs: mtime });
    expect(entries[0].thumbnail).toMatch(/^data:image\/png/);
    expect(entries[1]).toEqual({
      path: join(docs, "missing.sqraft"),
      name: "missing.sqraft",
      mtimeMs: null,
      thumbnail: null,
    });
  });
});
