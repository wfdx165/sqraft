import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEGACY_DOT_DIRNAME,
  MIGRATION_MARKER,
  USER_DATA_NAME,
  legacyDotDirOf,
  migrateFromLegacyDotDir,
  relocateImageCache,
  userDataDirOf,
} from "./data-dir";

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

/** 造一份典型的旧目录：应用数据 + Chromium 状态 + 可再生缓存 + 残留 */
async function makeLegacy(root: string): Promise<string> {
  const legacy = join(root, "legacy");
  await mkdir(join(legacy, "logs"), { recursive: true });
  await mkdir(join(legacy, "Local Storage"), { recursive: true });
  // 大小写不敏感卷上 Chromium 的 Cache/ 与应用的 cache/ 是同一目录，链接图缓存住在里面
  await mkdir(join(legacy, "Cache", "Cache_Data"), { recursive: true });
  await mkdir(join(legacy, "Cache", "images"), { recursive: true });
  await mkdir(join(legacy, "Code Cache"), { recursive: true });
  await writeFile(join(legacy, "preferences.json"), '{"recentFiles":["/a.sqraft"]}', "utf8");
  await writeFile(join(legacy, "logs", "sqraft.log"), "old log", "utf8");
  await writeFile(join(legacy, "mcp.json"), '{"port":7331}', "utf8");
  await writeFile(join(legacy, "Local Storage", "x.ldb"), "shortcuts", "utf8");
  await writeFile(join(legacy, "Cache", "Cache_Data", "f_1"), "http cache", "utf8");
  await writeFile(join(legacy, "Cache", "images", "key.bin"), "image", "utf8");
  await writeFile(join(legacy, "Code Cache", "f_2"), "code cache", "utf8");
  await writeFile(join(legacy, "mcp.sock"), "", "utf8");
  await writeFile(join(legacy, ".preferences.json.123.4.tmp"), "{}", "utf8");
  return legacy;
}

describe("数据目录（平台惯例 userData）", () => {
  it("userData 落在应用数据根下的 Sqraft，旧目录是 home 下的点目录", () => {
    expect(userDataDirOf("/Users/someone/Library/Application Support")).toBe(
      "/Users/someone/Library/Application Support/Sqraft",
    );
    expect(legacyDotDirOf("/Users/someone")).toBe(`/Users/someone/${LEGACY_DOT_DIRNAME}`);
    expect(USER_DATA_NAME).toBe("Sqraft");
  });

  it("首次迁移：应用数据、链接图缓存与 Chromium 状态归位，可再生缓存与残留留在旧目录", async () => {
    const root = await tempRoot();
    const legacy = await makeLegacy(root);
    const target = join(root, "target");
    const logs = join(root, "logs-out");

    const result = migrateFromLegacyDotDir({ legacy, target, logs });
    expect(result.status).toBe("migrated");

    // 应用自有数据
    expect(await readFile(join(target, "preferences.json"), "utf8")).toContain("/a.sqraft");
    // 日志走平台日志目录，不跟用户数据同目录
    expect(await readFile(join(logs, "sqraft.log"), "utf8")).toBe("old log");
    expect(existsSync(join(target, "logs"))).toBe(false);
    expect(await readFile(join(target, "mcp.json"), "utf8")).toContain("7331");
    // 链接图缓存：从 Chromium 的 Cache/ 里单独抽出来，落到不撞名的 image-cache/
    expect(await readFile(join(target, "image-cache", "key.bin"), "utf8")).toBe("image");
    // Chromium 状态（自定义快捷键就在这里）
    expect(await readFile(join(target, "Local Storage", "x.ldb"), "utf8")).toBe("shortcuts");
    // 迁移标记
    expect(existsSync(join(target, MIGRATION_MARKER))).toBe(true);

    // M2：可再生缓存与残留原地不动
    expect(existsSync(join(legacy, "Cache", "Cache_Data", "f_1"))).toBe(true);
    expect(existsSync(join(legacy, "Code Cache", "f_2"))).toBe(true);
    expect(existsSync(join(legacy, "mcp.sock"))).toBe(true);
    expect(existsSync(join(legacy, ".preferences.json.123.4.tmp"))).toBe(true);
    // 已搬走的不再留在旧目录
    expect(existsSync(join(legacy, "preferences.json"))).toBe(false);
    expect(existsSync(join(legacy, "Cache", "images"))).toBe(false);
  });

  it("链接图缓存不落进 Chromium 的 Cache/（大小写不敏感卷上两者是同一目录）", async () => {
    const root = await tempRoot();
    const legacy = await makeLegacy(root);
    const target = join(root, "target");
    // 目标侧已有上一版遗留下来的 Chromium HTTP 缓存
    await mkdir(join(target, "Cache", "Cache_Data"), { recursive: true });
    await writeFile(join(target, "Cache", "Cache_Data", "f_old"), "old", "utf8");

    migrateFromLegacyDotDir({ legacy, target, logs: join(root, "logs-out") });

    expect(existsSync(join(target, "image-cache", "key.bin"))).toBe(true);
    expect(existsSync(join(target, "Cache", "images"))).toBe(false);
    expect(existsSync(join(target, "Cache", "Cache_Data", "f_old"))).toBe(true);
  });

  it("被源覆盖的陈旧目标先归档、成功后清掉，不残留 .pre-migration", async () => {
    const root = await tempRoot();
    const legacy = await makeLegacy(root);
    const target = join(root, "target");
    await mkdir(join(target, "Local Storage"), { recursive: true });
    await writeFile(join(target, "Local Storage", "stale.ldb"), "stale", "utf8");

    migrateFromLegacyDotDir({ legacy, target, logs: join(root, "logs-out") });

    expect(await readFile(join(target, "Local Storage", "x.ldb"), "utf8")).toBe("shortcuts");
    expect(existsSync(join(target, "Local Storage", "stale.ldb"))).toBe(false);
    expect(existsSync(join(target, "Local Storage.pre-migration"))).toBe(false);
  });

  it("relocateImageCache：把误放进 Chromium Cache 的图片搬到 image-cache，不动 Cache_Data", async () => {
    const root = await tempRoot();
    const userData = join(root, "userData");
    await mkdir(join(userData, "cache", "images"), { recursive: true });
    await mkdir(join(userData, "Cache", "Cache_Data"), { recursive: true });
    await writeFile(join(userData, "cache", "images", "k.bin"), "img", "utf8");
    await writeFile(join(userData, "Cache", "Cache_Data", "f_1"), "http", "utf8");

    expect(relocateImageCache(userData)).not.toBeNull();
    expect(await readFile(join(userData, "image-cache", "k.bin"), "utf8")).toBe("img");
    expect(existsSync(join(userData, "Cache", "Cache_Data", "f_1"))).toBe(true);
    // 幂等：没有旧目录就 no-op
    expect(relocateImageCache(userData)).toBeNull();
  });

  it("目标侧的陈旧偏好被源覆盖（源为准）", async () => {
    const root = await tempRoot();
    const legacy = await makeLegacy(root);
    const target = join(root, "target");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "preferences.json"), '{"recentFiles":["stale"]}', "utf8");

    migrateFromLegacyDotDir({ legacy, target, logs: join(root, "logs-out") });
    expect(await readFile(join(target, "preferences.json"), "utf8")).toContain("/a.sqraft");
  });

  it("第二次调用看到标记直接返回，不重复搬", async () => {
    const root = await tempRoot();
    const legacy = await makeLegacy(root);
    const target = join(root, "target");

    const logs = join(root, "logs-out");
    expect(migrateFromLegacyDotDir({ legacy, target, logs }).status).toBe("migrated");
    await writeFile(join(legacy, "preferences.json"), '{"recentFiles":["later"]}', "utf8");

    expect(migrateFromLegacyDotDir({ legacy, target, logs }).status).toBe("already");
    expect(await readFile(join(target, "preferences.json"), "utf8")).toContain("/a.sqraft");
  });

  it("源不存在时是干净的 no-source", async () => {
    const root = await tempRoot();
    const target = join(root, "target");
    expect(
      migrateFromLegacyDotDir({ legacy: join(root, "absent"), target, logs: join(root, "logs-out") }).status,
    ).toBe("no-source");
    expect(existsSync(join(target, MIGRATION_MARKER))).toBe(false);
  });
});
