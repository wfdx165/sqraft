import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { anyPathExists, binSearchDirs, expandHome, fixedBinDirs, resolveExecutable } from "./detect";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-detect-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("路径展开与候选目录", () => {
  it("展开 ~", () => {
    expect(expandHome("~/bin/x", "/home/u")).toBe("/home/u/bin/x");
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("/opt/x", "/home/u")).toBe("/opt/x");
  });

  it("按平台给出固定目录", () => {
    const mac = fixedBinDirs({ home: "/Users/u", platform: "darwin", env: {} });
    expect(mac).toContain("/opt/homebrew/bin");
    const win = fixedBinDirs({
      home: "C:\\Users\\u",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
    });
    expect(win[0]).toBe(join("C:\\Users\\u\\AppData\\Roaming", "npm"));
  });

  it("合并 nvm 目录与 PATH，去重保序", async () => {
    const home = await tempDir();
    await mkdir(join(home, ".nvm", "versions", "node", "v22.12.0", "bin"), { recursive: true });
    const extra = join(home, "custom-bin");
    const dirs = await binSearchDirs({
      home,
      platform: "darwin",
      env: { PATH: [extra, "/usr/bin", extra].join(":") },
    });
    expect(dirs).toContain(join(home, ".nvm", "versions", "node", "v22.12.0", "bin"));
    expect(dirs.indexOf(extra)).toBe(dirs.lastIndexOf(extra));
    expect(dirs).toContain("/usr/bin");
  });
});

describe("可执行文件定位", () => {
  it("PATH 里找到可执行文件", async () => {
    const home = await tempDir();
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    const found = await resolveExecutable(["claude"], {
      home,
      platform: "darwin",
      env: { PATH: bin },
    });
    expect(found).toEqual({ path: join(bin, "claude"), batch: false });
  });

  it("非可执行文件跳过（POSIX）", async () => {
    const home = await tempDir();
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "claude"), "x", { mode: 0o644 });
    await chmod(join(bin, "claude"), 0o644);
    const found = await resolveExecutable(["claude"], { home, platform: "darwin", env: { PATH: bin } });
    expect(found).toBeNull();
  });

  it("Windows 上认 .cmd 并标记 batch", async () => {
    const home = await tempDir();
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "claude.cmd"), "@echo off\n");
    const found = await resolveExecutable(["claude"], { home, platform: "win32", env: { PATH: bin } });
    expect(found).toEqual({ path: join(bin, "claude.cmd"), batch: true });
  });

  it("找不到时返回 null", async () => {
    const home = await tempDir();
    expect(await resolveExecutable(["nope"], { home, platform: "darwin", env: { PATH: "" } })).toBeNull();
  });
});

describe("路径存在性", () => {
  it("任一路径存在即返回 true", async () => {
    const dir = await tempDir();
    expect(await anyPathExists([join(dir, "missing"), dir])).toBe(true);
    expect(await anyPathExists([join(dir, "missing")])).toBe(false);
  });
});
