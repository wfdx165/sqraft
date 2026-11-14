/**
 * 四语言 README 一致性校验（纯文件检查，不碰 git / 网络）。
 *
 * 用途：公开仓的 README 就是下载页，四份译文最容易"改一份忘三份"。
 * 原来这套规则长在 `publish-readme.mjs` 里——那个脚本负责把 README 推到发行仓，
 * 单仓化之后已经没有它的位置，但**校验本身仍然要留**：
 * `pnpm release` 的预检会调用本脚本，CI 也会跑一次。
 *
 * 规则（与旧脚本一致 + 一条新增）：
 * 1. 根目录只有 `README.md` / `README.zh-CN.md` / `README.ja-JP.md` / `README.ko-KR.md` 四份；
 * 2. 首行语言切换行必须链接到另外三份、且不链自己；
 * 3. 四份的二级标题数量必须一致；
 * 4. 不得再出现"闭源 / closed-source"这类与 Apache-2.0 冲突的表述。
 *
 * 用法：`node scripts/check-readmes.mjs`（在 apps/desktop 目录）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

/** 首屏是英文；其余按应用内的 locale 码命名。 */
const README_FILES = ["README.md", "README.zh-CN.md", "README.ja-JP.md", "README.ko-KR.md"];

/** 与 Apache-2.0 冲突的旧口径：见到就说明有一次合并把开源文案回退了。 */
const STALE_LICENSE = /闭源|closed-source|クローズドソース|클로즈드\s*소스/i;

const problems = [];

function fail(message) {
  problems.push(message);
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

const stray = readdirSync(repoRoot).filter(
  (name) => /^README.*\.md$/.test(name) && !README_FILES.includes(name),
);
if (stray.length > 0) {
  fail(`仓库根目录有多余的 README 文件：${stray.join("、")}（语言文件请按 ${README_FILES.slice(1).join(" / ")} 命名）`);
}

const counts = new Map();
for (const name of README_FILES) {
  const path = join(repoRoot, name);
  if (!existsSync(path)) {
    fail(`缺少 ${name}；四语言 README 必须齐全`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  if (!text.trim()) {
    fail(`${name} 是空文件`);
    continue;
  }
  const switcher = checkSwitcher(name, text);
  if (switcher) fail(`${name}：${switcher}`);
  if (STALE_LICENSE.test(text)) {
    fail(`${name}：仍写着闭源；Sqraft 以 Apache-2.0 开源，许可段应指向 LICENSE`);
  }
  counts.set(name, headingCount(text));
}

const [[base, expected]] = counts;
for (const [name, count] of counts) {
  if (count !== expected) fail(`${name} 有 ${count} 个二级标题，${base} 有 ${expected} 个：四份内容不同步`);
}

if (problems.length > 0) {
  console.error("check-readmes: 四语言 README 不合格");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// 兜底断言：缺文件/空文件都会在上面的 problems 分支先退出，正常到不了这里；
// 留着是为了将来若有人把某个 continue 挪到 counts.set 之前，报错仍然是上面那种而不是 TypeError。
if (counts.size === 0) {
  console.error("check-readmes: 没有读到任何一份 README，先确认仓库根目录里的文件还在");
  process.exit(1);
}

console.log(
  `check-readmes: 通过——${README_FILES.length} 份 README 齐全，切换链接完整，二级标题各 ${expected} 个，许可段一致`,
);
