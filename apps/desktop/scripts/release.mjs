/**
 * 发版：验收已有产物 → 创建 draft → 逐个上传。
 *
 * **本脚本不构建**：`pnpm dist` 负责"clean + build + 打包 + verify-pack"，并把
 * `release/build.json`（version / commit / dirty / 产物清单）写进产物目录。
 * 这里只读那份印章，确认产物就是当前提交构建出来的，然后上传。
 * 分开的好处：上传失败能单独重试，不用再花几分钟重建；Windows 的 exe 也不用
 * 因为 `clean` 被反复搬运。
 *
 * 版本号完全手动：唯一真源是 apps/desktop/package.json，本脚本只读不写，
 * 也不接受任何版本参数——避免"参数写一个版本、包里是另一个"。
 * 发版前手动完成：改 apps/desktop/package.json 的 version → `pnpm dist`
 * → 写 docs/releases/vX.Y.Z.md。说明文件缺失或为空即中止。
 * 脚本不检查本地 git 分支 / tag（只比对 build.json 里的 commit 与 HEAD）；
 * 发行仓的同名 tag 由 `gh release create` 创建。
 *
 * 用法（仓库根执行）：
 *   pnpm dist                                 # 构建（macOS 出 dmg + zip；Windows 出 NSIS）
 *   pnpm release                              # 验收产物 → 创建 draft release
 *   pnpm release --publish                    # 验收后直接发布（跳过 draft）
 *   pnpm release --win <路径>                  # 把 Windows 机器产出的 Setup.exe 收进 release/ 再发版
 *   pnpm release --preflight                  # 只跑检查，不构建、不上传
 *   pnpm publish:release                      # 把现有 draft 翻成正式发布
 *
 * 发布门槛：发布说明必须存在且非空、pnpm test 必须通过、build.json 的 commit 必须是 HEAD、
 * release/ 里 dmg / zip / exe 齐全；任一不满足即中止。
 * 版本策略：0.0.1 是内部开发版；0.0.2 是首个公开版；之后每次发版 patch。
 * macOS 只出 arm64；Windows 出 x64 的 NSIS 安装包，但必须在 Windows 机器上构建
 * （本机 mac 交叉构建不可靠，且无法验收）。两者缺一即中止发版。
 * 仓库地址来自 apps/desktop/update.config.json（客户端读同一份）。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareVersions, pickArm64Dmg, pickArm64Zip, pickWinSetup } from "./release-utils.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const desktopRoot = join(repoRoot, "apps/desktop");
const releaseDir = join(desktopRoot, "release");

const args = process.argv.slice(2);
const has = (name) => args.includes(name);

const HELP = `用法：
  pnpm dist                                 构建（macOS: dmg + zip；Windows: NSIS 安装器）
  pnpm release                              验收 release/ 里的产物并创建 draft release
  pnpm release --publish                    验收后直接发布
  pnpm release --win <路径>                  把 Windows 产出的 Setup.exe 收进 release/ 再发版
  pnpm release --preflight                  只跑检查（不构建、不上传）
  pnpm publish:release                      把现有 draft 翻成正式发布

版本号：手动改 apps/desktop/package.json；release 不接受版本参数。
前置：先跑 pnpm dist（它会写 release/build.json）；Windows 的 exe 手动放进 release/。
发布门槛：docs/releases/vX.md 存在且非空 + pnpm test 通过 + GitHub 凭证可用
          + build.json 的 commit 是 HEAD + release/ 里 dmg / zip / exe 齐全。
本地 git 分支 / tag 不参与判断；发行仓的 tag 由 gh release create 创建。
平台：macOS 只出 arm64（本机构建）；Windows 出 x64 安装包（必须在 Windows 机器上构建）。
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

/* ---------- 参数 ---------- */

/** `--win <路径>` / `--win=<路径>`：把 Windows 机器产出的 exe 收进 release/。 */
function takeWinPath(argv) {
  const rest = [];
  let winPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--win") {
      winPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--win=")) {
      winPath = arg.slice("--win=".length);
      continue;
    }
    rest.push(arg);
  }
  return { rest, winPath };
}

const { rest: flags, winPath } = takeWinPath(args);
if (winPath === "") fail("--win 需要一个安装包路径，例如 --win ~/Downloads/Sqraft-Setup-0.0.5.exe");

const KNOWN_FLAGS = new Set(["--publish", "--publish-draft", "--preflight", "--help", "-h"]);
const unknownFlags = flags.filter((arg) => !KNOWN_FLAGS.has(arg));
if (unknownFlags.length > 0) {
  fail(
    `未知参数：${unknownFlags.join(" ")}（版本号请直接改 apps/desktop/package.json；` +
      "构建请用 pnpm dist，`--skip-build` 已随 dist 解耦一并移除）",
  );
}

const preflightOnly = flags.includes("--preflight");
const publish = flags.includes("--publish");
const publishDraft = flags.includes("--publish-draft");

if (publish && publishDraft) fail("--publish 与 --publish-draft 不能同时用");

// 发版编排只在 macOS 上成立：它要上传 arm64 的 dmg/zip（在 mac 上构建）。
// --publish-draft 只翻 GitHub 上的 draft，不构建，不受此限。
if (process.platform !== "darwin" && !publishDraft) {
  fail(
    "release 只能在 macOS 上执行。Windows 产物请先在 Windows 机器上跑 pnpm dist，" +
      "把 Sqraft-Setup-<version>.exe 放进 apps/desktop/release/ 再发版",
  );
}

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
/**
 * 预检只**返回问题列表**，不打印也不退出：调用方决定是"发版前逐段拦住"还是"预检一次性报告"。
 * 分成 local / remote 两段：本地问题（说明、依赖、README、产物）应该先报，不该等 gh 超时。
 */
function localProblems({ requireNotes }) {
  const problems = [];

  if (requireNotes) {
    const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
    if (!notes.trim()) {
      problems.push(`缺少发布说明 ${notesPath}（或内容为空）；复制 docs/releases/v0.0.2.md 改名后填写`);
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

  // 四语言 README 是下载页的门面：标题数/切换链接/许可口径不一致就不该发版。
  const readmes = spawnSync(process.execPath, [join(desktopRoot, "scripts", "check-readmes.mjs")], {
    encoding: "utf8",
  });
  if (readmes.status !== 0) {
    problems.push(
      `四语言 README 校验失败：\n${(readmes.stderr || readmes.stdout).trim()}\n` +
        "  先跑 pnpm --filter @sqraft/desktop run check:readmes 看明细",
    );
  }

  return problems;
}

/** GitHub 侧：gh 可用性、仓库可见性/权限、版本只能往前走、同名 release 是否已存在。 */
function remoteProblems({ tagCheck }) {
  const problems = [];

  // 版本只能往前走：手改成更小的号会让下载页回退
  const latest = gh(["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"]);
  if (latest.status === 0) {
    const latestVersion = latest.stdout.trim().replace(/^v/, "");
    if (latestVersion && compareVersions(version, latestVersion) <= 0) {
      problems.push(`版本 ${version} 必须大于最新已发布版本 ${latestVersion}；否则下载页会指向旧版本`);
    }
  }

  const ghVersion = gh(["--version"]);
  if (ghVersion.status !== 0) {
    problems.push("找不到 gh（GitHub CLI）。先执行：brew install gh && gh auth login");
    return problems;
  }

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
    // 必须用 `--json`：不带它时 gh 走"按 tag 取 release"，看不到 draft；
    // 而跳过预检后 gh release create 会撞在"tag 已存在"上，白跑一遍测试与校验。
    const release = gh(["release", "view", tag, "--repo", repo, "--json", "tagName"]);
    const exists = release.status === 0;
    if (tagCheck === "absent" && exists) {
      problems.push(
        `release ${tag} 已存在；先改 apps/desktop/package.json 的 version，或删掉旧 release 与 tag`,
      );
    }
    if (tagCheck === "exists" && !exists) {
      problems.push(`找不到 release ${tag}，先跑 pnpm release 生成 draft`);
    }
  }

  return problems;
}

/** 任何一条问题都中止：发版不该"带着警告继续"。 */
function report(problems) {
  if (problems.length > 0) fail(problems.join("\nrelease: "));
}

/* ---------- 产物验收 ---------- */

/** `--win <路径>`：把 Windows 机器产出的安装包收进 release/（后续步骤只认这个目录）。 */
function stageWinInstaller() {
  if (!winPath) return;
  const from = resolve(repoRoot, winPath);
  if (!existsSync(from)) fail(`--win 指定的文件不存在：${from}`);
  mkdirSync(releaseDir, { recursive: true });
  const to = join(releaseDir, `Sqraft-Setup-${version}.exe`);
  copyFileSync(from, to);
  console.log(`release: 已收下 Windows 安装包 → ${to}`);
}

/** 当前提交；不是 git 仓库时返回空串（从源码包构建也可以发版）。 */
function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

/**
 * 读 `dist` 写的印章，确认 release/ 里的产物就是**当前提交**构建出来的。
 *
 * 这是"构建与上传解耦"唯一需要补的防护：没有它，改完代码忘了重新 dist 就会
 * 把旧包发出去，而版本号、文件名、sha256 全都没法暴露这件事。
 * 返回问题列表 + 印章（读不出来时印章为 null）。
 */
function stampProblems() {
  const problems = [];
  const stampPath = join(releaseDir, "build.json");
  if (!existsSync(stampPath)) {
    problems.push("release/ 里没有 build.json：先跑 pnpm dist（本机构建），再发版");
    return { problems, stamp: null };
  }
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch (error) {
    problems.push(
      `build.json 读不了（${error instanceof Error ? error.message : String(error)}）：重跑 pnpm dist`,
    );
    return { problems, stamp: null };
  }
  if (stamp.version !== version) {
    problems.push(`build.json 的版本是 ${String(stamp.version)}，package.json 是 ${version}：重跑 pnpm dist`);
  }
  const head = gitHead();
  if (stamp.commit && head && stamp.commit !== head) {
    problems.push(
      `build.json 记录的是 ${String(stamp.commit).slice(0, 7)}，当前 HEAD 是 ${head.slice(0, 7)}：` +
        "产物不是这个提交构建的，重跑 pnpm dist",
    );
  }
  if (stamp.dirty) {
    console.warn(
      "release: 注意：构建时工作区不干净（build.json 的 dirty=true），产物可能不含已提交之后的改动",
    );
  }
  return { problems, stamp };
}

/** release/ 里必须同时有当前版本的 dmg / zip / exe；缺哪个说哪个，不自动构建。 */
function artifactProblems(stamp) {
  const problems = [];
  const files = existsSync(releaseDir) ? readdirSync(releaseDir) : [];
  const dmg = pickArm64Dmg(files, version);
  const zip = pickArm64Zip(files, version);
  const exe = pickWinSetup(files, version);
  const missing = [];
  if (!dmg) missing.push(`macOS dmg（Sqraft-${version}-arm64.dmg）`);
  if (!zip) missing.push(`macOS zip（Sqraft-${version}-arm64-mac.zip，自动更新只认它）`);
  if (!exe) missing.push(`Windows 安装包（Sqraft-Setup-${version}.exe）`);
  if (missing.length > 0) {
    problems.push(
      `release/ 里缺少：${missing.join("、")}\n` +
        "  本机产物：pnpm dist；Windows 产物：在 Windows 机器上 pnpm dist 后拷进 release/，" +
        "或用 --win <路径> 指定",
    );
    return { problems, artifacts: null };
  }

  // 本机构建的印章里应该列出 dmg/zip：对不上说明 release/ 混进了上一版或手工放的文件
  const stamped = new Set((stamp?.artifacts ?? []).map((item) => item.name));
  if (stamped.size === 0) {
    problems.push("build.json 里没有产物清单：那是 dist:dir 的构建，发版请用 pnpm dist");
  }
  for (const name of [dmg, zip]) {
    if (stamped.size > 0 && !stamped.has(name)) {
      problems.push(`${name} 不在本次构建的产物清单里（build.json）：重跑 pnpm dist`);
    }
  }

  for (const name of [dmg, zip, exe]) {
    if (statSync(join(releaseDir, name)).size < 1024 * 1024) {
      problems.push(`${name} 体积异常，构建可能没完成`);
    }
  }
  return { problems, artifacts: { dmg, zip, exe } };
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

async function writeManifest({ dmg, zip, exe }) {
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
      // Windows 客户端只读 version 做提示，不下载：地址留着给以后接自动安装
      "win-x64": {
        url: assetUrl(exe),
        size: statSync(join(releaseDir, exe)).size,
        sha256: await sha256(join(releaseDir, exe)),
      },
    },
  };
  const manifestPath = join(releaseDir, "latest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, assets: [dmg, zip, exe] };
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

/** 一次把本地、产物、远端的问题全列出来：预检退出时用户只需要看一份清单。 */
function allProblems() {
  const { problems: stampProblemsList, stamp } = stampProblems();
  return [
    ...localProblems({ requireNotes: true }),
    ...stampProblemsList,
    ...artifactProblems(stamp).problems,
    ...remoteProblems({ tagCheck: "absent" }),
  ];
}

if (preflightOnly) {
  const problems = allProblems();
  if (problems.length > 0) {
    console.error(`release: 预检未通过（${tag} → ${repo}）`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`release: 预检通过（${tag} → ${repo}）`);
  process.exit(0);
}

if (publishDraft) {
  report(remoteProblems({ tagCheck: "exists" }));
  const view = gh(["release", "view", tag, "--repo", repo, "--json", "isDraft,assets"]);
  if (view.status !== 0) fail(`读取 release ${tag} 失败`);
  const info = JSON.parse(view.stdout);
  if (!info.isDraft) fail(`${tag} 已经是正式发布`);
  const names = (info.assets ?? []).map((asset) => asset.name);
  const missing = ["latest.json", "dmg", "zip", "exe"].filter(
    (required) => !names.some((name) => name.includes(required)),
  );
  if (missing.length > 0) {
    fail(
      `draft 里缺少 ${missing.join("、")} 资产；补传再做发布（不用重新构建）：\n` +
        `  gh release upload ${tag} apps/desktop/release/Sqraft-${version}-arm64.dmg ` +
        `apps/desktop/release/Sqraft-${version}-arm64-mac.zip ` +
        `apps/desktop/release/Sqraft-Setup-${version}.exe ` +
        `apps/desktop/release/latest.json --repo ${repo} --clobber`,
    );
  }

  run("gh", ["release", "edit", tag, "--repo", repo, "--draft=false"]);
  await waitForLatest();
  process.exit(0);
}

// 1) 本地能查的先查完：说明文件、依赖分类、四语 README
report(localProblems({ requireNotes: true }));
// 2) 收下 Windows 安装包，再验产物是不是当前提交构建的
stageWinInstaller();
const { problems: stampProblemsList, stamp } = stampProblems();
report(stampProblemsList);
const { problems: artifactProblemsList, artifacts } = artifactProblems(stamp);
report(artifactProblemsList);

// 3) 发版闸门：没测过不发版（本脚本不再构建，测试是唯一与产物无关的硬检查）
run("pnpm", ["test"]);
// 成品防护验收（ADR-0030）：源码 / 依赖漏回包里就在这里中止，而不是把包传上去
run("node", ["scripts", "verify-pack.mjs"], { cwd: desktopRoot });

// 4) 远端检查放在最后：避免本地问题还没修就先等 gh 超时
report(remoteProblems({ tagCheck: "absent" }));

const { manifestPath } = await writeManifest(artifacts);
const uploads = [artifacts.dmg, artifacts.zip, artifacts.exe].map((name) => join(releaseDir, name));
uploads.push(manifestPath);

// 5) 先建 draft，再逐个上传：单文件失败能定位、能直接重试，不会留下"只有 latest.json"的半成品。
run("gh", [
  "release",
  "create",
  tag,
  "--repo",
  repo,
  "--title",
  `Sqraft ${version}`,
  "--notes-file",
  notesPath,
  "--draft",
]);

for (const file of uploads) {
  console.log(`release: 上传 ${basename(file)} …`);
  run("gh", ["release", "upload", tag, file, "--repo", repo, "--clobber"]);
}

// 6) 上传后回读一次：gh 逐文件上传，任何一步失败都不该被"脚本退出码 0"掩盖。
const view = gh(["release", "view", tag, "--repo", repo, "--json", "assets"]);
if (view.status !== 0) fail(`读取 ${tag} 的资产失败：${(view.stderr ?? "").trim()}`);
const uploaded = (JSON.parse(view.stdout).assets ?? []).map((asset) => asset.name);
const expected = [artifacts.dmg, artifacts.zip, artifacts.exe, "latest.json"];
const missingAssets = expected.filter((name) => !uploaded.includes(name));
if (missingAssets.length > 0) {
  fail(
    `draft 里缺少资产：${missingAssets.join("、")}\n` +
      "  单独重试（不用重新构建）：\n" +
      `  gh release upload ${tag} ${missingAssets.map((name) => join("apps/desktop/release", name)).join(" ")} --repo ${repo} --clobber\n` +
      "  补传后执行 pnpm publish:release",
  );
}

if (publish) {
  run("gh", ["release", "edit", tag, "--repo", repo, "--draft=false"]);
  await waitForLatest();
} else {
  console.log(`release: 已创建 ${tag} 的 draft（4 个资产已核对）。`);
  console.log("release: 验收后执行 pnpm publish:release 正式发布");
}
