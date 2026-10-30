import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_MARKER, dataDirOf, prepareDataDir } from "./data-dir";

let roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-data-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
  roots = [];
});

describe("数据目录", () => {
  it("落在 home 下的 .sqraft", () => {
    expect(dataDirOf("/Users/someone")).toBe("/Users/someone/.sqraft");
  });

  it("首次启动把旧目录的偏好复制过来并写迁移标记", async () => {
    const home = await tempRoot();
    const legacy = join(home, "Library", "Application Support", "Sqraft");
    await rm(legacy, { recursive: true, force: true });
    await import("node:fs/promises").then((fs) => fs.mkdir(legacy, { recursive: true }));
    await writeFile(join(legacy, "preferences.json"), '{"recentFiles":["/a.sqraft"]}', "utf8");

    const target = await prepareDataDir(legacy, home);
    expect(target).toBe(join(home, ".sqraft"));
    expect(await readFile(join(target, "preferences.json"), "utf8")).toContain("/a.sqraft");
    expect(existsSync(join(target, MIGRATION_MARKER))).toBe(true);
  });

  it("第二次启动不再覆盖新目录里已有的偏好", async () => {
    const home = await tempRoot();
    const legacy = join(home, "legacy");
    await import("node:fs/promises").then((fs) => fs.mkdir(legacy, { recursive: true }));
    await writeFile(join(legacy, "preferences.json"), '{"recentFiles":["old"]}', "utf8");
    await prepareDataDir(legacy, home);
    await writeFile(join(home, ".sqraft", "preferences.json"), '{"recentFiles":["new"]}', "utf8");

    await prepareDataDir(legacy, home);
    expect(await readFile(join(home, ".sqraft", "preferences.json"), "utf8")).toContain("new");
  });
});
