/**
 * 把对外的四语言 README 与截图同步到发行仓库（wfdx165/sqraft）。
 *
 * 用法：`pnpm publish:readme`
 *
 * 源码仓库在 Gitea，发行仓库只放下载页与安装包，所以这里用一个临时 clone：
 * 删掉远端旧的 README.*.md → 复制 README.md + README.<locale>.md + docs/images/ →
 * 有变化才提交 → 推 main（空仓库首次自动建分支）。
 *
 * 四份 README 由 `validateReadmes()` 把关：文件齐全、首行语言切换链接完整、
 * 二级标题数量一致。翻译最容易出现"改了一份忘了另外三份"，就在这里拦下。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const repo = JSON.parse(readFileSync(join(repoRoot, "apps/desktop/update.config.json"), "utf8")).repo;
const COMMIT_MESSAGE = "docs: 同步四语言 README 与截图";

/** 首屏是英文；其余按应用内的 locale 码命名。 */
const README_FILES = ["README.md", "README.zh-CN.md", "README.ja-JP.md", "README.ko-KR.md"];

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

/** 数 `##` 标题：四份译文必须一一对应，避免整段漏翻。 */
function headingCount(text) {
  return text.split("\n").filter((line) => /^##\s/.test(line)).length;
}

/** 首行语言切换行：必须链接到另外三份，且不能链到自己。 */
function checkSwitcher(name, text) {
  const first = text.split("\n").find((line) => line.trim()) ?? "";
  for (const other of README_FILES) {
    if (other === name) {
      if (first.includes(`](${other})`)) return `首行不应链接到自己：${name}`;
      continue;
    }
    if (!first.includes(`](${other})`)) return `首行缺少 ${other} 的切换链接`;
  }
  return "";
}

function validateReadmes() {
  const stray = readdirSync(repoRoot).filter(
    (name) => /^README.*\.md$/.test(name) && !README_FILES.includes(name),
  );
  if (stray.length > 0) {
    fail(`仓库根目录有多余的 README 文件：${stray.join("、")}（语言文件请按 ${README_FILES.slice(1).join(" / ")} 命名）`);
  }

  const counts = new Map();
  for (const name of README_FILES) {
    const path = join(repoRoot, name);
    if (!existsSync(path)) fail(`缺少 ${name}；四语言 README 必须齐全`);
    const text = readFileSync(path, "utf8");
    if (!text.trim()) fail(`${name} 是空文件`);
    const switcher = checkSwitcher(name, text);
    if (switcher) fail(`${name}：${switcher}`);
    counts.set(name, headingCount(text));
  }

  const [[base, expected]] = counts;
  for (const [name, count] of counts) {
    if (count !== expected) fail(`${name} 有 ${count} 个二级标题，${base} 有 ${expected} 个：四份内容不同步`);
  }
}

if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) fail(`update.config.json 的 repo 不合法：${repo}`);
validateReadmes();
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

  // 精确镜像：先删远端残留的语言文件，再整体覆盖（重命名/删语言时不留死链）
  for (const name of readdirSync(target)) {
    if (/^README\..+\.md$/.test(name)) rmSync(join(target, name));
  }
  for (const name of README_FILES) {
    cpSync(join(repoRoot, name), join(target, name));
  }

  const images = join(repoRoot, "docs/images");
  if (existsSync(images)) {
    mkdirSync(join(target, "docs/images"), { recursive: true });
    cpSync(images, join(target, "docs/images"), { recursive: true });
    console.log(`publish:readme: 已复制 ${README_FILES.join(" / ")} 与 docs/images/`);
  } else {
    console.log(`publish:readme: 没有 docs/images/，只复制 ${README_FILES.join(" / ")}`);
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
