/**
 * 出包：按宿主平台选 electron-builder 目标，构建完跑成品防护验收（ADR-0030）。
 *
 * 为什么不做交叉构建：`electron-builder.yml` 的 `electronDist` 指向宿主机那份已解压的
 * Electron，`--mac` 从 Windows 跑会把 Windows 的运行时塞进 mac 包；反过来同理。另外
 * Windows 产物必须在 Windows 上验收（ADR-0033）。所以"自动判断"只等于"跟着当前机器走"，
 * 也不提供 `--win` 这类强制指定平台的口子。
 *
 * 目标写死而不用默认值：
 * - macOS 永远 `--mac --arm64`：`release-utils.mjs`、`latest.json` 与更新器都只认 arm64，
 *   Intel 机器上出 x64 会在发版时炸在"找不到 arm64 产物"。
 * - Windows 永远 `--win --x64`：只发 NSIS 安装器（ADR-0033），且它是将来静默更新的路径。
 *
 * 不支持的平台直接报错，不退化：`electron-builder.yml` 没有 `linux:` 段，
 * `after-pack.mjs` 对非 mac/win 也不翻转 fuse，出来的目录是半成品。
 *
 * 用法：`pnpm dist`（脚本前面已经跑过 clean 与 build）。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");

/** 宿主 → electron-builder 参数；不支持的平台返回 null。 */
function builderArgs(platform) {
  if (platform === "darwin") return ["--mac", "--arm64"];
  if (platform === "win32") return ["--win", "--x64"];
  return null;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", cwd: desktopRoot, ...options });
  if (result.error) {
    console.error(`dist: 无法执行 ${command}：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`dist: ${command} ${commandArgs.join(" ")} 失败（exit ${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

const args = builderArgs(process.platform);
if (!args) {
  console.error(
    `dist: 不支持在 ${process.platform} 上出包——本项目只在 macOS（arm64）与 Windows（x64）上打包。\n` +
      "  只想验证构建：pnpm build；只想快速出个未打包目录：pnpm dist:dir。",
  );
  process.exit(1);
}

// 直接跑 electron-builder 的 cli.js：Windows 上 node_modules/.bin 里是 .cmd，
// 不经 shell 无法 spawn，经 shell 又要处理引号——用 node 起入口最稳。
const require = createRequire(pathToFileURL(join(desktopRoot, "package.json")));
const builderCli = require.resolve("electron-builder/cli.js");

console.log(`dist: ${process.platform} → electron-builder ${args.join(" ")}`);
run(process.execPath, [builderCli, ...args]);
// 成品防护验收（ADR-0030）：源码 / 依赖漏回包里就在这里中止，而不是把包传上去
run(process.execPath, [join(desktopRoot, "scripts", "verify-pack.mjs")]);
