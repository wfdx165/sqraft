/**
 * 本地演练：把本地产物伪装成"已下载完成"，用来验证替换与回滚链路。
 *
 * 为什么需要它：客户端固定从 `releases/latest` 读取，draft / 本地 feed 都进不去，
 * 所以"发布前完整走一遍自动更新"在现有信任模型下做不到。能验证的部分——
 * 退出替换、备份、启动标记、超时回滚——不依赖网络，用这个脚本就能跑。
 *
 * 用法（仓库根）：
 *   pnpm stage:update                 # 用 release/ 里与 apps/desktop/package.json 同版本的 zip
 *   pnpm stage:update --zip path.zip  # 指定包
 *   pnpm stage:update --force         # 应用还开着也继续（不推荐）
 *
 * 前提：目标版本必须**高于**当前安装的版本，否则启动时会被当成残留清掉。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pickArm64Zip } from "./release-utils.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const desktopRoot = join(repoRoot, "apps/desktop");
const releaseDir = join(desktopRoot, "release");

const force = process.argv.includes("--force");
const zipArgIndex = process.argv.indexOf("--zip");
const zipArg = zipArgIndex === -1 ? null : process.argv[zipArgIndex + 1];

function fail(message) {
  console.error(`stage:update: ${message}`);
  process.exit(1);
}

function userDataDir() {
  if (process.env.SQRAFT_USER_DATA) return process.env.SQRAFT_USER_DATA;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Sqraft");
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Sqraft");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Sqraft");
}

/** 应用开着的时候它内存里的偏好会在退出时覆盖磁盘：必须先退。 */
function appRunning() {
  if (process.platform === "win32") return false;
  const result = spawnSync("pgrep", ["-f", "Sqraft.app/Contents/MacOS/"], { stdio: "ignore" });
  return result.status === 0;
}

if (appRunning() && !force) {
  fail("Sqraft 正在运行。先退出应用再演练（它在内存里持有偏好，退出时会覆盖磁盘）");
}

const version = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")).version;

let zipPath = zipArg ? resolve(repoRoot, zipArg) : null;
if (!zipPath) {
  const candidate = pickArm64Zip(readdirSync(releaseDir), version);
  if (!candidate) fail(`release/ 里找不到 ${version} 的 arm64 zip，先跑 pnpm dist`);
  zipPath = join(releaseDir, candidate);
}
if (!existsSync(zipPath)) fail(`找不到 ${zipPath}`);

const userData = userDataDir();
const updates = join(userData, "updates");
mkdirSync(updates, { recursive: true });
copyFileSync(zipPath, join(updates, "update.zip"));

const preferencesPath = join(userData, "preferences.json");
let preferences = {};
if (existsSync(preferencesPath)) {
  try {
    preferences = JSON.parse(readFileSync(preferencesPath, "utf8"));
  } catch {
    fail(`${preferencesPath} 不是合法 JSON，先修好它再演练`);
  }
}
preferences.update = {
  ...(preferences.update ?? {}),
  readyVersion: version,
  readySince: Date.now(),
};
// 上一轮的失败记录不该影响这次演练
delete preferences.update.failedVersion;
delete preferences.update.remindedVersion;
writeFileSync(preferencesPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");

console.log(`stage:update: 已把 ${version} 的包放进 ${join(updates, "update.zip")}`);
console.log("下一步：启动 Sqraft → 工具栏出现「重启更新」→ 点它（或直接 ⌘Q）→ 观察替换与启动");
console.log("回滚演练：把 update.zip 换成一个能解包但起不来的包，重复上面的步骤");
