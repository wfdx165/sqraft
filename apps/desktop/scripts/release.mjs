/**
 * 发布一版：出包 → 算 sha256 → 生成 latest.json → 传 GitHub Release。
 *
 * 用法（在仓库根执行）：
 *   pnpm release            # 打包并创建 draft release（先自测再手动 publish）
 *   pnpm release --publish  # 直接发布（draft 之外还要确认一次才用这个）
 *   pnpm release --skip-build   # 复用 release/ 里已有产物（补传元数据时用）
 *
 * 版本号唯一真源是根 package.json；apps/desktop/package.json 必须与它一致。
 * 仓库地址来自 apps/desktop/update.config.json——客户端读的是同一份。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const desktopRoot = join(repoRoot, "apps/desktop");
const releaseDir = join(desktopRoot, "release");

const publish = process.argv.includes("--publish");
const skipBuild = process.argv.includes("--skip-build");

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: repoRoot, ...options });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} 失败（exit ${result.status}）`);
}

const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const desktopPkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const version = rootPkg.version;
if (desktopPkg.version !== version) {
  fail(`版本不一致：根 ${version} / desktop ${desktopPkg.version}（先把两处改成同一个值）`);
}

const config = JSON.parse(readFileSync(join(desktopRoot, "update.config.json"), "utf8"));
const repo = config.repo;
if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) fail(`update.config.json 的 repo 不合法：${repo}`);
if (repo.startsWith("REPLACE_ME")) fail("先把 apps/desktop/update.config.json 的 repo 改成真实仓库");

const tag = `v${version}`;

if (!skipBuild) run("pnpm", ["--filter", "@sqraft/desktop", "run", "dist:mac"]);

const files = readdirSync(releaseDir);
const dmg = files.find((name) => name.endsWith(`-${version}-arm64.dmg`));
const zip = files.find((name) => name.endsWith(`-${version}-arm64.zip`));
if (!dmg) fail(`release/ 里找不到 ${version} 的 arm64 dmg`);
if (!zip) fail(`release/ 里找不到 ${version} 的 arm64 zip（自动更新只认 zip）`);

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function sizeOf(name) {
  return statSync(join(releaseDir, name)).size;
}

const notesPath = join(repoRoot, "docs/releases", `${tag}.md`);
const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
if (!notes.trim()) console.warn(`release: 没有 ${notesPath}，这次发布不带更新说明`);

const assetUrl = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;

const manifest = {
  version,
  publishedAt: new Date().toISOString(),
  notes,
  assets: {
    "mac-arm64": {
      url: assetUrl(zip),
      size: sizeOf(zip),
      sha256: await sha256(join(releaseDir, zip)),
    },
    "mac-arm64-dmg": {
      url: assetUrl(dmg),
      size: sizeOf(dmg),
      sha256: await sha256(join(releaseDir, dmg)),
    },
  },
};
const manifestPath = join(releaseDir, "latest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const existing = spawnSync("gh", ["release", "view", tag], { cwd: repoRoot, stdio: "ignore" });
if (existing.status === 0) fail(`${tag} 已经存在；版本号必须先升（latest.json 不能指向已经发布的版本）`);

const notesArgs = notes.trim() ? ["--notes-file", notesPath] : ["--notes", `Sqraft ${version}`];
const args = [
  "release",
  "create",
  tag,
  "--title",
  `Sqraft ${version}`,
  ...notesArgs,
  ...(publish ? [] : ["--draft"]),
  join(releaseDir, dmg),
  join(releaseDir, zip),
  manifestPath,
];
run("gh", args);

console.log(
  publish
    ? `release: 已发布 ${tag}（客户端 24 小时内会看到）`
    : `release: 已创建 ${tag} 的 draft。先用旧版完整走一遍检查 → 下载 → 重启更新，再在 GitHub 上 publish`,
);
