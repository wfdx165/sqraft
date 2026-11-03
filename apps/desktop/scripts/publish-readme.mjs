/**
 * 把对外 README 与截图同步到发行仓库（wfdx165/sqraft）。
 *
 * 用法：`pnpm publish:readme`
 *
 * 源码仓库在 Gitea，发行仓库只放下载页与安装包，所以这里用一个临时 clone：
 * 复制 README.md + docs/images/ → 有变化才提交 → 推 main（空仓库首次自动建分支）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const repo = JSON.parse(readFileSync(join(repoRoot, "apps/desktop/update.config.json"), "utf8")).repo;
const COMMIT_MESSAGE = "docs: 同步 README 与截图";

function fail(message) {
  console.error(`publish:readme: ${message}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", cwd: repoRoot, ...options });
  if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} 失败（exit ${result.status}）`);
}

function output(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", cwd: repoRoot, ...options });
  return result.status === 0 ? result.stdout.trim() : "";
}

if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) fail(`update.config.json 的 repo 不合法：${repo}`);
if (!existsSync(join(repoRoot, "README.md"))) fail("仓库根目录没有 README.md");
if (!output("gh", ["--version"])) fail("找不到 gh（GitHub CLI）。先执行：brew install gh && gh auth login");
if (spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status !== 0) {
  fail("gh 未登录。执行：gh auth login");
}
if (!output("git", ["config", "user.name"]) || !output("git", ["config", "user.email"])) {
  fail("git 缺少 user.name / user.email，先配置后再推");
}

const temp = mkdtempSync(join(tmpdir(), "sqraft-release-"));
const target = join(temp, "repo");
try {
  console.log(`publish:readme: 克隆 ${repo} …`);
  // 空仓库也能克隆成功（只有警告），后续 checkout -B main 负责建分支
  run("gh", ["repo", "clone", repo, target, "--", "--depth=1"], { cwd: temp });
  run("git", ["checkout", "-B", "main"], { cwd: target });

  cpSync(join(repoRoot, "README.md"), join(target, "README.md"));
  const images = join(repoRoot, "docs/images");
  if (existsSync(images)) {
    mkdirSync(join(target, "docs/images"), { recursive: true });
    cpSync(images, join(target, "docs/images"), { recursive: true });
    console.log("publish:readme: 已复制 README.md 与 docs/images/");
  } else {
    console.log("publish:readme: 没有 docs/images/，只复制 README.md");
  }

  const dirty = output("git", ["status", "--porcelain"], { cwd: target });
  if (!dirty) {
    console.log("publish:readme: 发行仓库内容没有变化，跳过提交");
  } else {
    run("git", ["add", "-A"], { cwd: target });
    run("git", ["commit", "--no-verify", "-m", COMMIT_MESSAGE], { cwd: target });
    run("git", ["push", "-u", "origin", "main"], { cwd: target });
    console.log(`publish:readme: 已更新 https://github.com/${repo}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
