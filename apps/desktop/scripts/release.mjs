/**
 * 发版：构建 → 上传 draft → 发布。
 *
 * 版本号完全手动：唯一真源是 apps/desktop/package.json，本脚本只读不写，
 * 也不接受任何版本参数——避免"参数写一个版本、包里是另一个"。
 * 发版前手动完成：改 apps/desktop/package.json 的 version → 写
 * docs/releases/vX.Y.Z.md → 提交并推送 → 打并推送源码 tag `vX`
 * （发行仓的同名 tag 由 `gh release create` 另建）。
 *
 * 用法（仓库根执行）：
 *   pnpm release                              # 测试 → 构建 → 创建 draft release
 *   pnpm release --publish                    # 构建并直接发布（跳过 draft）
 *   pnpm release --skip-build                 # 复用 release/ 里已有产物（跳过测试）
 *   pnpm release --preflight                  # 只跑检查，不构建
 *   pnpm publish:release                      # 把现有 draft 翻成正式发布，不重建
 *
 * 发布门槛：工作区必须干净、pnpm test 必须通过；任一不满足即中止。
 * 源码追溯：发版前在私有仓打 tag `vX` 并推送；预检要求 tag 指向 HEAD 且 HEAD 已推送到 origin。
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
  pnpm publish:readme                       同步 README 与截图到发行仓库

版本号：手动改 apps/desktop/package.json；release 不接受版本参数。
发布门槛：工作区干净 + HEAD 已推送 + 源码 tag 已推送 + pnpm test 通过。
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

function git(commandArgs) {
  return spawnSync("git", commandArgs, { cwd: repoRoot, encoding: "utf8" });
}

/* ---------- 预检 ---------- */

/**
 * `strict` = 发布前检查：任何一项不满足都中止。
 * `tagCheck`：absent = 发布前不能已有 tag；exists = 发布 draft 前必须已有；skip = 不检查。
 * `requireClean`：出包/预检要求工作区干净（draft 翻正式不重新构建，不要求）。
 */
function preflight({ strict, tagCheck, requireClean = false }) {
  const problems = [];
  const notes = [];
  if (requireClean) {
    const status = git(["status", "--porcelain"]);
    if (status.status !== 0) {
      problems.push("git status 失败，无法确认工作区是否干净");
    } else if (status.stdout.trim()) {
      problems.push(`工作区不干净，先提交或清理：\n${status.stdout.trim()}`);
    }

    // 源码追溯：HEAD 必须已推送到 origin，源码 tag 必须存在、指向 HEAD 且已推送
    const head = git(["rev-parse", "HEAD"]);
    const headSha = head.status === 0 ? head.stdout.trim() : "";
    const baseRef = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const branch = baseRef.status === 0 ? baseRef.stdout.trim().replace(/^origin\//, "") : "main";
    const remote = git(["ls-remote", "--heads", "origin", branch]);
    const remoteSha = remote.status === 0 ? (remote.stdout.trim().split(/\s+/)[0] ?? "") : "";

    if (!headSha || !remoteSha) {
      problems.push("无法确认 HEAD 与 origin 的同步状态（检查 origin 是否可访问）");
    } else if (headSha !== remoteSha) {
      problems.push(
        `HEAD ${headSha.slice(0, 7)} 尚未推送到 origin/${branch}（远端 ${remoteSha.slice(0, 7)}）；先 git push`,
      );
    }

    const localTag = git(["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]);
    const tagSha = localTag.status === 0 ? localTag.stdout.trim() : "";
    if (!tagSha) {
      problems.push(
        `缺少源码 tag ${tag}；先执行 git tag -a ${tag} -m "Sqraft ${version}" 并 git push origin ${tag}`,
      );
    } else if (headSha && tagSha !== headSha) {
      problems.push(
        `源码 tag ${tag} 不指向当前 HEAD（${tagSha.slice(0, 7)} ≠ ${headSha.slice(0, 7)}）；先修正 tag`,
      );
    }

    // annotated tag 用 ^{} 取 commit；轻量 tag 没有 peeled 行，退回普通引用
    const peeled = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}^{}`]);
    const plain = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
    const remoteTagSha = peeled.status === 0 && peeled.stdout.trim()
      ? peeled.stdout.trim().split(/\s+/)[0]
      : plain.status === 0
        ? (plain.stdout.trim().split(/\s+/)[0] ?? "")
        : "";
    if (!remoteTagSha) {
      problems.push(`源码 tag ${tag} 未推送到 origin；执行 git push origin ${tag}`);
    } else if (headSha && remoteTagSha !== headSha) {
      problems.push(
        `远端源码 tag ${tag} 不指向当前 HEAD（${remoteTagSha.slice(0, 7)} ≠ ${headSha.slice(0, 7)}）；先修正并强制推送 tag`,
      );
    }

    // 版本只能往前走：手改成更小的号会让下载页回退
    const latest = gh(["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"]);
    if (latest.status === 0) {
      const latestVersion = latest.stdout.trim().replace(/^v/, "");
      if (latestVersion && compareVersions(version, latestVersion) <= 0) {
        problems.push(`版本 ${version} 必须大于最新已发布版本 ${latestVersion}；否则下载页会指向旧版本`);
      }
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

  if (strict && !existsSync(notesPath)) notes.push(`没有 ${notesPath}，本次发布不带更新说明`);

  for (const line of notes) console.warn(`release: 提示：${line}`);
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
  const head = git(["rev-parse", "HEAD"]);
  if (head.status !== 0) fail("读不到当前 commit，无法写入 latest.json");
  const commit = head.stdout.trim();
  const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
  if (!notes.trim()) console.warn(`release: 没有 ${notesPath}，这次发布不带更新说明`);
  const assetUrl = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const manifest = {
    version,
    commit,
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
  preflight({ strict: true, tagCheck: "absent", requireClean: true });
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

preflight({ strict: true, tagCheck: "absent", requireClean: true });
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
  ...(existsSync(notesPath) ? ["--notes-file", notesPath] : ["--notes", `Sqraft ${version}`]),
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
