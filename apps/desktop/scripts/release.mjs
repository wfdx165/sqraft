/**
 * 发版：构建 → 上传 draft → 发布。
 *
 * 版本号完全手动：唯一真源是 apps/desktop/package.json，本脚本只读不写，
 * 也不接受任何版本参数——避免"参数写一个版本、包里是另一个"。
 * 发版前手动完成：改 apps/desktop/package.json 的 version → 写
 * docs/releases/vX.Y.Z.md。说明文件缺失或为空即中止。
 * 脚本不检查本地 git 状态（分支、工作区、tag 都不参与判断）；发行仓的同名
 * tag 由 `gh release create` 创建，源码 tag 由需要的人自行管理。
 *
 * 用法（仓库根执行）：
 *   pnpm release                              # 测试 → 构建 → 创建 draft release
 *   pnpm release --publish                    # 构建并直接发布（跳过 draft）
 *   pnpm release --skip-build                 # 复用 release/ 里已有产物（跳过测试）
 *   pnpm release --preflight                  # 只跑检查，不构建
 *   pnpm publish:release                      # 把现有 draft 翻成正式发布，不重建
 *
 * 发布门槛：发布说明必须存在且非空、pnpm test 必须通过；任一不满足即中止。
 * 版本策略：0.0.1 是内部开发版；0.0.2 是首个公开版；之后每次发版 patch。
 * 仅支持 macOS arm64；仓库地址来自 apps/desktop/update.config.json（客户端读同一份）。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareVersions, pickArm64Dmg, pickArm64Zip } from "./release-utils.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const desktopRoot = join(repoRoot, "apps/desktop");
const releaseDir = join(desktopRoot, "release");

const args = process.argv.slice(2);
const has = (name) => args.includes(name);

const HELP = `用法：
  pnpm release                              构建并创建 draft release
  pnpm release --publish                    构建并直接发布
  pnpm release --skip-build                 复用 release/ 里已有产物（跳过测试）
  pnpm release --preflight                  只跑检查
  pnpm publish:release                      把现有 draft 翻成正式发布（不重建）

版本号：手动改 apps/desktop/package.json；release 不接受版本参数。
发布门槛：docs/releases/vX.md 存在且非空 + pnpm test 通过 + GitHub 凭证可用。
本地 git 状态（分支 / 工作区 / tag）不参与判断；源码 tag 由需要的人自行管理。
版本策略：0.0.1 内部开发版；0.0.2 首个公开版；之后每次 patch。`;

if (has("--help") || has("-h")) {
  console.log(HELP);
  process.exit(0);
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

for (const flag of ["--bump", "--version"]) {
  if (has(flag)) fail(`${flag} 已移除：版本号请直接改 apps/desktop/package.json`);
}

const KNOWN_FLAGS = new Set(["--publish", "--publish-draft", "--skip-build", "--preflight", "--help", "-h"]);
const unknownFlags = args.filter((arg) => !KNOWN_FLAGS.has(arg));
if (unknownFlags.length > 0) {
  fail(`未知参数：${unknownFlags.join(" ")}（版本号请直接改 apps/desktop/package.json）`);
}

const preflightOnly = has("--preflight");
const publish = has("--publish");
const publishDraft = has("--publish-draft");
const skipBuild = has("--skip-build");

if (publish && publishDraft) fail("--publish 与 --publish-draft 不能同时用");

const desktopPkgPath = join(desktopRoot, "package.json");
const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, "utf8"));
const version = desktopPkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`apps/desktop/package.json 的 version 不合法：${String(version)}（必须是 x.y.z）`);
}
const repo = JSON.parse(readFileSync(join(desktopRoot, "update.config.json"), "utf8")).repo;

if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) fail(`update.config.json 的 repo 不合法：${repo}`);
const tag = `v${version}`;
const notesPath = join(repoRoot, "docs/releases", `${tag}.md`);

/* ---------- 基础工具 ---------- */

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", cwd: repoRoot, ...options });
  if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} 失败（exit ${result.status}）`);
}

function gh(commandArgs, options = {}) {
  return spawnSync("gh", commandArgs, { cwd: repoRoot, encoding: "utf8", ...options });
}

/* ---------- 预检 ---------- */

/**
 * `strict` = 发布前检查：任何一项不满足都中止。
 * `tagCheck`：absent = 发布前不能已有 release；exists = 发布 draft 前必须已有；skip = 不检查。
 * `requireNotes`：发版（预检 / 出包）要求发布说明存在且非空；draft 翻正式不重复检查。
 *
 * 这里只看 GitHub 侧与本地文件，不看 git 分支、工作区或 tag：发版的产出是 GitHub 上的
 * 一次 release，源码怎么管理不归这个脚本判断。
 */
function preflight({ strict, tagCheck, requireNotes = false }) {
  const problems = [];

  if (requireNotes) {
    const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
    if (!notes.trim()) {
      problems.push(
        `缺少发布说明 ${notesPath}（或内容为空）；复制 docs/releases/v0.0.2.md 改名后填写`,
      );
    }
  }

  // 版本只能往前走：手改成更小的号会让下载页回退
  const latest = gh(["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"]);
  if (latest.status === 0) {
    const latestVersion = latest.stdout.trim().replace(/^v/, "");
    if (latestVersion && compareVersions(version, latestVersion) <= 0) {
      problems.push(`版本 ${version} 必须大于最新已发布版本 ${latestVersion}；否则下载页会指向旧版本`);
    }
  }

  // 运行时不需要任何 node_modules；有运行时依赖就会被整棵复制进 asar（ADR-0030）
  const runtimeDeps = Object.keys(desktopPkg.dependencies ?? {});
  if (runtimeDeps.length > 0) {
    problems.push(
      `apps/desktop/package.json 的 dependencies 应为空，实际有：${runtimeDeps.join("、")}` +
        "（只在构建期用的依赖请放 devDependencies）",
    );
  }

  const ghVersion = gh(["--version"]);
  if (ghVersion.status !== 0) {
    problems.push("找不到 gh（GitHub CLI）。先执行：brew install gh && gh auth login");
  } else {
    const auth = gh(["auth", "status"]);
    if (auth.status !== 0) problems.push("gh 未登录。执行：gh auth login");

    const view = gh(["repo", "view", repo, "--json", "visibility,viewerPermission"]);
    if (view.status !== 0) {
      problems.push(`无法访问仓库 ${repo}（检查仓库是否存在、gh 账号是否有权限）`);
    } else {
      try {
        const info = JSON.parse(view.stdout);
        if (info.visibility !== "PUBLIC") problems.push(`仓库 ${repo} 不是 public（自动更新会 404）`);
        if (!["ADMIN", "MAINTAIN", "WRITE"].includes(info.viewerPermission)) {
          problems.push(`当前 gh 账号对 ${repo} 没有写权限（viewerPermission=${info.viewerPermission}）`);
        }
      } catch {
        problems.push("无法解析 gh repo view 的输出");
      }
    }

    if (tagCheck !== "skip") {
      const release = gh(["release", "view", tag, "--repo", repo]);
      const exists = release.status === 0;
      if (tagCheck === "absent" && exists) {
        problems.push(`release ${tag} 已存在；先改 apps/desktop/package.json 的 version，或删掉旧 release 与 tag`);
      }
      if (tagCheck === "exists" && !exists) {
        problems.push(`找不到 release ${tag}，先跑 pnpm release 生成 draft`);
      }
    }
  }

  if (problems.length > 0) {
    if (strict) fail(problems.join("\nrelease: "));
    for (const problem of problems) console.warn(`release: 警告：${problem}`);
  }
  return { problems };
}

/* ---------- 构建与上传 ---------- */

function buildArtifacts() {
  if (skipBuild) {
    console.log("release: --skip-build，复用 release/ 里已有产物（跳过测试）");
  } else {
    run("pnpm", ["test"]);
    run("pnpm", ["--filter", "@sqraft/desktop", "run", "dist"], {
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    });
  }

  // 成品防护验收（ADR-0030）：源码 / 依赖漏回包里就在这里中止，而不是把包传上去
  run("node", ["scripts/verify-pack.mjs"], { cwd: desktopRoot });

  const files = readdirSync(releaseDir);
  const dmg = pickArm64Dmg(files, version);
  const zip = pickArm64Zip(files, version);
  if (!dmg) fail(`release/ 里找不到 ${version} 的 arm64 dmg`);
  if (!zip) fail(`release/ 里找不到 ${version} 的 arm64 zip（自动更新只认 zip）`);
  for (const name of [dmg, zip]) {
    if (statSync(join(releaseDir, name)).size < 1024 * 1024) fail(`${name} 体积异常，构建可能没完成`);
  }
  return { dmg, zip };
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function writeManifest({ dmg, zip }) {
  const notes = readFileSync(notesPath, "utf8");
  const assetUrl = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const manifest = {
    version,
    publishedAt: new Date().toISOString(),
    notes,
    assets: {
      "mac-arm64": {
        url: assetUrl(zip),
        size: statSync(join(releaseDir, zip)).size,
        sha256: await sha256(join(releaseDir, zip)),
      },
      "mac-arm64-dmg": {
        url: assetUrl(dmg),
        size: statSync(join(releaseDir, dmg)).size,
        sha256: await sha256(join(releaseDir, dmg)),
      },
    },
  };
  const manifestPath = join(releaseDir, "latest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, assets: [dmg, zip] };
}

/** 发布后轮询固定地址：GitHub 的 latest 有缓存，刚发布时可能还是旧内容。 */
async function waitForLatest() {
  const url = `https://github.com/${repo}/releases/latest/download/latest.json`;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (response.ok) {
        const manifest = await response.json();
        if (manifest.version === version) {
          console.log(`release: ${url} 已生效（version=${version}）`);
          return;
        }
        console.log(`release: latest.json 仍是 ${manifest.version}，等待…`);
      }
    } catch {
      // 网络抖动继续等
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
  }
  fail(`已发布，但 ${url} 还没更新到 ${version}；过几分钟用 curl 复查`);
}

/* ---------- 主流程 ---------- */

if (preflightOnly) {
  preflight({ strict: true, tagCheck: "absent", requireNotes: true });
  console.log(`release: 预检通过（${tag} → ${repo}）`);
  process.exit(0);
}

if (publishDraft) {
  preflight({ strict: true, tagCheck: "exists" });
  const view = gh(["release", "view", tag, "--repo", repo, "--json", "isDraft,assets"]);
  if (view.status !== 0) fail(`读取 release ${tag} 失败`);
  const info = JSON.parse(view.stdout);
  if (!info.isDraft) fail(`${tag} 已经是正式发布`);
  const names = (info.assets ?? []).map((asset) => asset.name);
  for (const required of ["latest.json", "dmg", "zip"]) {
    const found = names.some((name) => name.includes(required));
    if (!found) fail(`draft 里缺少 ${required} 资产，先重新 pnpm release`);
  }

  run("gh", ["release", "edit", tag, "--repo", repo, "--draft=false"]);
  await waitForLatest();
  process.exit(0);
}

preflight({ strict: true, tagCheck: "absent", requireNotes: true });
const artifacts = buildArtifacts();
const { manifestPath, assets } = await writeManifest(artifacts);

const createArgs = [
  "release",
  "create",
  tag,
  "--repo",
  repo,
  "--title",
  `Sqraft ${version}`,
  "--notes-file",
  notesPath,
  ...(publish ? [] : ["--draft"]),
  ...assets.map((name) => join(releaseDir, name)),
  manifestPath,
];
run("gh", createArgs);

if (publish) {
  await waitForLatest();
} else {
  console.log(`release: 已创建 ${tag} 的 draft。`);
  console.log("release: 验收后执行 pnpm publish:release 正式发布（不重新构建）");
}
