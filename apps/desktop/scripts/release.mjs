/**
 * 发版：升版本 → 构建 → 上传 draft → 发布。
 *
 * 用法（仓库根执行）：
 *   pnpm release --bump [patch|minor|major]   # 升版本（默认 patch）+ 生成说明模板，不构建
 *   pnpm release --version 0.0.2              # 显式指定版本（首个公开版用一次）
 *   pnpm release                              # 构建并创建 draft release
 *   pnpm release --publish                    # 构建并直接发布（跳过 draft）
 *   pnpm release --skip-build                 # 复用 release/ 里已有产物
 *   pnpm release --preflight                  # 只跑检查，不构建
 *   pnpm publish:release                      # 把现有 draft 翻成正式发布，不重建
 *
 * 版本策略：0.0.1 是内部开发版；0.0.2 是首个公开版；之后每次发版 patch。
 * 仅支持 macOS arm64；仓库地址来自 apps/desktop/update.config.json（客户端读同一份）。
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

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("-") ? value : "";
};

const HELP = `用法：
  pnpm release --bump [patch|minor|major]   升版本（默认 patch）+ 生成说明模板，不构建
  pnpm release --version <x.y.z>            显式指定版本（首个公开版用一次）
  pnpm release                              构建并创建 draft release
  pnpm release --publish                    构建并直接发布
  pnpm release --skip-build                 复用 release/ 里已有产物
  pnpm release --preflight                  只跑检查
  pnpm publish:release                      把现有 draft 翻成正式发布（不重建）
  pnpm publish:readme                       同步 README 与截图到发行仓库

版本策略：0.0.1 内部开发版；0.0.2 首个公开版；之后每次 patch。`;

if (has("--help") || has("-h")) {
  console.log(HELP);
  process.exit(0);
}

const bumpIndex = args.indexOf("--bump");
const bumpKind = bumpIndex === -1 ? null : (valueOf("--bump") || "patch");
const explicitVersion = valueOf("--version");
if (args.includes("--version") && !explicitVersion) fail("--version 需要值，例如 --version 0.0.2");
const bumpMode = bumpKind !== null || explicitVersion !== null;
const preflightOnly = has("--preflight");
const publish = has("--publish");
const publishDraft = has("--publish-draft");
const skipBuild = has("--skip-build");

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

if (publish && publishDraft) fail("--publish 与 --publish-draft 不能同时用");
if (bumpMode && (publish || publishDraft || skipBuild || preflightOnly)) {
  fail("--bump / --version 只负责改版本，不能和构建/发布参数混用");
}
if (bumpKind !== null && !["patch", "minor", "major"].includes(bumpKind)) {
  fail(`--bump 只接受 patch / minor / major，收到 ${bumpKind}`);
}

const rootPkgPath = join(repoRoot, "package.json");
const desktopPkgPath = join(desktopRoot, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, "utf8"));
const version = rootPkg.version;
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

function compareVersions(a, b) {
  const parse = (value) => value.trim().replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function bump(current, kind) {
  const parts = current.split(".").map((part) => Number.parseInt(part, 10) || 0);
  if (kind === "major") return `${parts[0] + 1}.0.0`;
  if (kind === "minor") return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

/* ---------- 预检 ---------- */

/**
 * `strict` = 发布前检查：任何一项不满足都中止。
 * 升版本时用 soft：没装 gh 也能改版本，只是给出提醒。
 * `tagCheck`：absent = 发布前不能已有 tag；exists = 发布 draft 前必须已有；skip = 不检查。
 */
function preflight({ strict, tagCheck }) {
  const problems = [];
  const notes = [];
  if (rootPkg.version !== desktopPkg.version) {
    problems.push(`版本不一致：根 ${rootPkg.version} / desktop ${desktopPkg.version}`);
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
        problems.push(`release ${tag} 已存在；先升版本，或删掉旧 release 与 tag`);
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

/* ---------- 改版本 ---------- */

/** 只替换第一个 version 字段，避免整份 JSON 重写把无关格式改动混进来。 */
function rewriteVersion(source, next, label) {
  const pattern = /("version"\s*:\s*")[^"]*(")/;
  if (!pattern.test(source)) fail(`${label} 里找不到 version 字段`);
  const updated = source.replace(pattern, `$1${next}$2`);
  const before = JSON.parse(source);
  const after = JSON.parse(updated);
  const normalized = { ...after, version: before.version };
  if (JSON.stringify(normalized) !== JSON.stringify(before)) {
    fail(`${label} 的 version 替换影响了其它字段，已中止`);
  }
  return updated;
}

function bumpFiles(next) {
  const files = [
    { path: rootPkgPath, label: "package.json" },
    { path: desktopPkgPath, label: "apps/desktop/package.json" },
  ];
  // 先在内存里把两份都算好并校验，任何一份不合格都不会留下半截状态
  const planned = files.map((file) => {
    const source = readFileSync(file.path, "utf8");
    return { ...file, source, updated: rewriteVersion(source, next, file.label) };
  });
  const written = [];
  try {
    for (const file of planned) {
      writeFileSync(file.path, file.updated, "utf8");
      written.push(file);
    }
  } catch (error) {
    // 写第二份失败时把第一份恢复，避免两处版本不一致
    for (const file of written) writeFileSync(file.path, file.source, "utf8");
    throw error;
  }
}

function writeNotesTemplate(next) {
  const target = join(repoRoot, "docs/releases", `v${next}.md`);
  if (existsSync(target)) return target;
  const body = `## ${next}

- 

## 已知限制

- 仅提供 macOS Apple Silicon（arm64）安装包
- 未签名、未公证，首次打开需要在应用上右键 → 打开
`;
  writeFileSync(target, body, "utf8");
  return target;
}

/* ---------- 构建与上传 ---------- */

function buildArtifacts() {
  if (skipBuild) {
    console.log("release: --skip-build，复用 release/ 里已有产物");
  } else {
    run("pnpm", ["--filter", "@sqraft/desktop", "run", "dist:mac"], {
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    });
  }

  const files = readdirSync(releaseDir);
  const find = (suffixes) => files.find((name) => suffixes.some((suffix) => name.endsWith(suffix)));
  const dmg = find([`-${version}-arm64.dmg`]);
  const zip = find([`-${version}-arm64.zip`, `-${version}-arm64-mac.zip`]);
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

if (bumpMode) {
  preflight({ strict: false, tagCheck: "skip" });
  const current = rootPkg.version;
  const next = explicitVersion || bump(current, bumpKind);
  if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`版本号不合法：${next}`);
  if (compareVersions(next, current) <= 0) fail(`新版本 ${next} 必须大于当前 ${current}`);

  const existing = gh(["--version"]).status === 0 ? gh(["release", "view", `v${next}`, "--repo", repo]) : null;
  if (existing && existing.status === 0) fail(`release v${next} 已存在，换一个版本号`);

  bumpFiles(next);
  const createdNotes = writeNotesTemplate(next);
  console.log(`release: 版本已改为 ${next}（根 + desktop）`);
  console.log(`release: 更新说明：${createdNotes}`);
  console.log("release: 下一步：写说明 → pnpm release");
  process.exit(0);
}

if (preflightOnly) {
  preflight({ strict: true, tagCheck: "absent" });
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

preflight({ strict: true, tagCheck: "absent" });
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
