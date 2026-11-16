import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyManifest,
  loadManifest,
  MANIFEST_FILENAME,
  removeClient,
  sanitizeManifest,
  saveManifest,
  setClient,
} from "./manifest";
import type { ManagedClientRecord } from "./types";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-manifest-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const record: ManagedClientRecord = {
  channel: "file",
  target: "/home/u/.cursor/mcp.json",
  entry: "sqraft",
  url: "http://127.0.0.1:7331/mcp",
  attachedAt: "2026-11-16T08:00:00.000Z",
  lastSyncAt: "2026-11-16T08:00:00.000Z",
};

describe("所有权清单", () => {
  it("文件不存在时返回空清单", async () => {
    const dir = await tempDir();
    expect(await loadManifest(join(dir, MANIFEST_FILENAME))).toEqual(emptyManifest());
  });

  it("保存后能读回，权限 0600", async () => {
    const dir = await tempDir();
    const file = join(dir, MANIFEST_FILENAME);
    const manifest = setClient(emptyManifest(), "cursor", record);
    await saveManifest(file, manifest);
    expect(await loadManifest(file)).toEqual(manifest);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("损坏 JSON 与未知版本都退化为空清单", async () => {
    const dir = await tempDir();
    const file = join(dir, MANIFEST_FILENAME);
    await writeFile(file, "{ not json");
    expect(await loadManifest(file)).toEqual(emptyManifest());
    await writeFile(file, JSON.stringify({ version: 2, clients: { cursor: record } }));
    expect(await loadManifest(file)).toEqual(emptyManifest());
  });

  it("坏记录被丢弃，好记录保留", () => {
    const manifest = sanitizeManifest({
      version: 1,
      clients: {
        cursor: record,
        zed: { ...record, channel: "nope" },
        codex: { ...record, url: "" },
        bogus: record,
      },
    });
    expect(Object.keys(manifest.clients)).toEqual(["cursor"]);
    expect(manifest.clients.cursor).toEqual(record);
  });

  it("写入与移除不修改原对象", () => {
    const base = emptyManifest();
    const added = setClient(base, "zed", record);
    const removed = removeClient(added, "zed");
    expect(base.clients).toEqual({});
    expect(added.clients.zed).toEqual(record);
    expect(removed.clients).toEqual({});
  });
});
