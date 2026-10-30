import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addRecent, loadPreferences, removeRecent, savePreferences } from "./preferences";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-prefs-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("最近打开列表", () => {
  it("新路径置顶且不重复", () => {
    expect(addRecent(["/a", "/b"], "/c")).toEqual(["/c", "/a", "/b"]);
    expect(addRecent(["/a", "/b"], "/b")).toEqual(["/b", "/a"]);
  });

  it("超过上限时丢弃最旧的", () => {
    const list = ["/1", "/2", "/3", "/4", "/5", "/6", "/7", "/8"];
    expect(addRecent(list, "/9")).toHaveLength(8);
    expect(addRecent(list, "/9")[0]).toBe("/9");
    expect(addRecent(list, "/9")).not.toContain("/8");
  });

  it("可以剔除失效条目", () => {
    expect(removeRecent(["/a", "/b"], "/a")).toEqual(["/b"]);
  });
});

describe("偏好读写", () => {
  it("写入后能原样读回", async () => {
    const file = join(await tempDir(), "preferences.json");
    await savePreferences(file, { recentFiles: ["/x", "/y"] });
    expect(await loadPreferences(file)).toEqual({ recentFiles: ["/x", "/y"] });
  });

  it("文件缺失时回退默认值", async () => {
    const file = join(await tempDir(), "missing.json");
    expect(await loadPreferences(file)).toEqual({ recentFiles: [] });
  });

  it("JSON 损坏时回退默认值而不抛错", async () => {
    const file = join(await tempDir(), "broken.json");
    await writeFile(file, "{not json");
    expect(await loadPreferences(file)).toEqual({ recentFiles: [] });
  });

  it("形状不对时过滤掉非字符串条目", async () => {
    const file = join(await tempDir(), "odd.json");
    await writeFile(file, JSON.stringify({ recentFiles: ["/a", 42, null] }));
    expect(await loadPreferences(file)).toEqual({ recentFiles: ["/a"] });
  });
});
