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
 * macOS 发版必须签名（ADR-0034）；公证当前关闭（见下方 NOTARIZE）：
 * - 签名身份不写死，靠钥匙串自动发现（`mac.forceCodeSigning` 保证找不到就失败）；
 * - 构建前先查证书与 entitlements；恢复公证时再查凭据与 notarytool，别等构建跑完才报错；
 * - 签完再跑 `verify-pack --expect-signed`：签名、Team、hardened runtime、entitlements；
 *   真做了公证时再加 `--expect-notarized`（Gatekeeper 接受 + 票据已 staple）。
 * 只想快速出个能跑的包（不签名、不公证）用 `pnpm dist:dir`。
 *
 * 用法：`pnpm dist`（脚本前面已经跑过 clean 与 build）；`pnpm dist:dir` 传 `--dir`，
 * 只出未打包目录（`.app` / `win-unpacked`），仍然受同一套平台守卫与成品校验约束。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { notaryCredentialSource } from "./release-utils.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");

/** `--dir`：只出目录，不建 dmg / 安装器（快速验证打包后能不能跑）。 */
const dirOnly = process.argv.includes("--dir");
const isMac = process.platform === "darwin";

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

/** 静默执行并收集输出：只用于前置检查，失败自己报错，不在这里退出。 */
function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: desktopRoot, encoding: "utf8" });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * 公证凭据来源见 `release-utils.mjs` 的 `notaryCredentialSource()`（纯函数、有单测）。
 */

/**
 * 本轮是否做公证（ADR-0034「后续修订」）。
 *
 * 2026-11 起 macOS 包用 Developer ID 签名；Apple 公证服务当时连续两次提交各卡在
 * `In Progress` 约 24 小时（`notarytool log` 也取不到），于是先只上签名。
 * **恢复公证**：这里改成 true，同步 `electron-builder.yml` 的 `mac.notarize`，
 * verify-pack 的 `--expect-notarized` 会由本开关自动传给发版链路。
 */
const NOTARIZE = false;

/**
 * macOS 发版前置检查：证书、entitlements、（恢复公证时）凭据与 notarytool。
 *
 * 必须在 electron-builder 之前查：它找不到证书时只 warn 一句就**静默跳过签名**，
 * 于是白跑几分钟、还可能把未签名的包传进 draft。
 */
function macSigningPreflight() {
  // 签名用的都得随仓库提交：少了 plist，electron-builder 会在签名阶段丢一行英文错误
  for (const name of ["entitlements.mac.plist", "entitlements.mac.inherit.plist"]) {
    const file = join(desktopRoot, "build", name);
    if (!existsSync(file)) {
      console.error(`dist: 缺 ${file}——签名用的 entitlements 必须随仓库提交（ADR-0034）`);
      process.exit(1);
    }
  }
  const identities = capture("security", ["find-identity", "-v", "-p", "codesigning"]);
  const line = identities.out.split("\n").find((item) => item.includes("Developer ID Application"));
  if (!line) {
    console.error(
      "dist: 找不到 Developer ID Application 证书，无法签名发版。\n" +
        "  检查：security find-identity -v -p codesigning\n" +
        "  只想出个不签名、不公证的快包：pnpm dist:dir",
    );
    process.exit(1);
  }
  const identity = line.match(/"([^"]+)"/)?.[1] ?? line.trim();
  const teamId = identity.match(/\(([A-Z0-9]{10})\)/)?.[1] ?? "";

  if (!NOTARIZE) {
    console.log(
      `dist: 签名身份 ${identity}${teamId ? `（Team ${teamId}）` : ""}；本轮不做公证（NOTARIZE=false）`,
    );
    return { identity, teamId, credential: null, notarized: false };
  }

  const credential = notaryCredentialSource(process.env);
  if (!credential) {
    console.error(
      "dist: 缺少公证凭据，electron-builder 会跳过公证。在 shell profile 里配一组：\n" +
        "  APPLE_API_KEY（.p8 路径）+ APPLE_API_KEY_ID + APPLE_API_ISSUER（推荐）\n" +
        "  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID\n" +
        "  APPLE_KEYCHAIN_PROFILE\n" +
        "  只想出个不签名、不公证的快包：pnpm dist:dir",
    );
    process.exit(1);
  }
  if (credential.kind === "incomplete") {
    console.error(`dist: 公证凭据不完整——${credential.detail}`);
    process.exit(1);
  }
  if (credential.kind === "api-key" && !existsSync(credential.keyPath)) {
    console.error(`dist: APPLE_API_KEY 指向的 .p8 不存在：${credential.keyPath}`);
    process.exit(1);
  }
  if (capture("xcrun", ["--find", "notarytool"]).status !== 0) {
    console.error("dist: 找不到 notarytool——公证需要完整 Xcode（只有 Command Line Tools 时没有它）");
    process.exit(1);
  }
  console.log(
    `dist: 签名身份 ${identity}${teamId ? `（Team ${teamId}）` : ""}；` +
      `公证凭据 ${credential.kind === "api-key" ? "App Store Connect API Key" : credential.kind === "apple-id" ? "Apple ID 专用密码" : "keychain profile"}`,
  );
  return { identity, teamId, credential: credential.kind, notarized: true };
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

const builderFlags = [...args, ...(dirOnly ? ["--dir"] : [])];
const builderEnv = { ...process.env };
/** 发版构建的签名信息；写入 build.json，并决定 verify-pack 是否断言签名（`--dir` / Windows 为 null）。 */
let signing = null;

if (isMac && dirOnly) {
  // 快验路径：不签名、不公证。adhoc 签名由 after-pack 的 fuse 翻转自己补，
  // 保持 release/ 里的目录能跑；不写 build.json，release 也不会认它。
  builderFlags.push("-c.mac.notarize=false", "-c.mac.forceCodeSigning=false");
  builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
} else if (isMac) {
  signing = macSigningPreflight();
}

console.log(`dist: ${process.platform} → electron-builder ${builderFlags.join(" ")}`);
if (signing) {
  console.log(
    `dist: 接下来是签名${signing.notarized ? " → 公证" : ""}：嵌套 bundle 逐个签，` +
      "期间没有进度输出，通常 1–3 分钟（TSA 链路慢时可能到 8 分钟）。",
  );
}
run(process.execPath, [builderCli, ...builderFlags], { env: builderEnv });

// 成品防护验收（ADR-0030 / ADR-0034）：源码 / 依赖漏回包里、或包没签好，都在这里中止。
const verifyArgs = [join(desktopRoot, "scripts", "verify-pack.mjs")];
if (signing) {
  verifyArgs.push("--expect-signed");
  if (signing.teamId) verifyArgs.push("--team-id", signing.teamId);
  // 只有真做了公证才断言 Gatekeeper / 票据；本轮 NOTARIZE=false，签名有效但未公证
  if (signing.notarized) verifyArgs.push("--expect-notarized");
}
run(process.execPath, verifyArgs);

/* ---------- 构建印章（release.mjs 用它确认产物来自当前提交） ---------- */

/** 当前提交与"是否带未提交改动"；不是 git 仓库时都留空，不阻断构建。 */
function gitInfo() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: desktopRoot, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: desktopRoot,
    encoding: "utf8",
  });
  return {
    commit: head.status === 0 ? head.stdout.trim() : "",
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

if (dirOnly) {
  // `dist:dir` 只出未打包目录，没有可上传的产物：不写印章，避免 release 误判
  console.log("dist: --dir 模式不写 build.json（发版请用 pnpm dist）");
} else {
  const releaseDir = join(desktopRoot, "release");
  const { version } = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  const artifacts = existsSync(releaseDir)
    ? readdirSync(releaseDir)
        .filter((name) => name.includes(version) && /\.(dmg|zip|exe)$/.test(name))
        .map((name) => ({ name, size: statSync(join(releaseDir, name)).size }))
    : [];
  const stamp = {
    version,
    ...gitInfo(),
    platform: process.platform,
    builtAt: new Date().toISOString(),
    // macOS 发版带签名信息；Windows 与 --dir 构建为 null。真正的签名结果由
    // verify-pack --expect-signed 断言，这里只用来让 release 拒绝"切换前的旧包 / 未签名包"。
    signing,
    artifacts,
  };
  writeFileSync(join(releaseDir, "build.json"), `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  console.log(
    `dist: 已写 build.json（${stamp.commit ? stamp.commit.slice(0, 7) : "no-git"}${stamp.dirty ? ", dirty" : ""}，` +
      `${artifacts.length} 个产物${signing ? `，已签名（Team ${signing.teamId || "?"}）` : "，未签名"}）`,
  );
}
