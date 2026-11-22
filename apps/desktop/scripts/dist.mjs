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
 * macOS 发版必须签名 + 公证（ADR-0034 / 2026-11-22 修订）：
 * - 签名身份不写死，靠钥匙串自动发现（`mac.forceCodeSigning` 保证找不到就失败）；
 * - 构建前先查证书、entitlements、公证凭据、`notarytool`，并探测 Apple 服务可达性，
 *   别等构建跑完才报错；
 * - 公证在 `afterSign` 钩子里做（`scripts/after-sign.mjs`）：签完 `.app` 立刻提交、轮询、staple，
 *   然后 electron-builder 才打 dmg / zip——票据必须进包；
 * - 最后跑 `verify-pack --expect-signed --expect-notarized`：签名、Team、hardened runtime、
 *   entitlements、Gatekeeper 接受、票据已 staple。
 *
 * 三个出口：
 * - `pnpm dist`：完整流程（签名 → 公证 → dmg / zip → 验收）；
 * - `pnpm dist:resume`：公证失败 / 超时后复用已签好的 `.app` 续跑，不重新构建；
 * - `pnpm dist:dir`：只出未打包目录（adhoc、不签名、不公证），用于"打包后能不能跑"的快验。
 *
 * `pnpm dist --no-notarize` 是显式逃生口：只签名不公证，产物记 `notarized:false`，
 * `pnpm release` 会拒收——能应急出包，但发不出去。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { notaryAuthArgs, notarizeApp, readNotaryState } from "./notarize.mjs";
import { notaryCredentialSource } from "./release-utils.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const releaseDir = join(desktopRoot, "release");

/** `--dir`：只出目录，不建 dmg / 安装器（快速验证打包后能不能跑）。 */
const dirOnly = process.argv.includes("--dir");
/** `--resume`：公证失败 / 超时后复用已签好的 `.app`，只补公证、staple 与打包。 */
const resume = process.argv.includes("--resume");
/** `--no-notarize`：显式跳过公证（产物记 notarized:false，release 拒收）。 */
const skipNotarize = process.argv.includes("--no-notarize");
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
function capture(command, commandArgs, timeout = 30_000) {
  const result = spawnSync(command, commandArgs, { cwd: desktopRoot, encoding: "utf8", timeout });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * 本轮是否做公证（ADR-0034 / 2026-11-22 修订）：默认开。
 *
 * 2026-11-13 曾因为 Apple 侧两次提交各挂约 24 小时而整体关掉（这两次最终都是 Accepted）。
 * 现在改由 `afterSign` 自己轮询：20 秒一行状态、60 分钟硬上限，卡住会明确失败并给
 * `pnpm dist:resume` 入口，不会再有"静默等一天"。只签名不公证的应急包走 `--no-notarize`。
 */
const NOTARIZE = true;

/** 签名用的 entitlements 必须随仓库提交：少了 plist，electron-builder 会在签名阶段丢一行英文错误。 */
function assertEntitlements() {
  for (const name of ["entitlements.mac.plist", "entitlements.mac.inherit.plist"]) {
    const file = join(desktopRoot, "build", name);
    if (!existsSync(file)) {
      console.error(`dist: 缺 ${file}——签名用的 entitlements 必须随仓库提交（ADR-0034）`);
      process.exit(1);
    }
  }
}

/**
 * Developer ID Application 身份：必须在 electron-builder 之前查。
 *
 * 它找不到证书时只 warn 一句就**静默跳过签名**，于是白跑几分钟、还可能把未签名的包传进 draft。
 */
function macIdentity() {
  assertEntitlements();
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
  return { identity, teamId };
}

/**
 * 公证前置检查：凭据成套、`notarytool` 存在、Apple 服务可达。
 *
 * `notarytool history` 是只读探测：401 / 凭据无效立刻失败；纯网络不通只告警，
 * 让构建继续（提交时会再试，避免一次 DNS 抖动就浪费一轮构建）。
 */
function notaryPreflight(env) {
  const credential = notaryCredentialSource(env);
  if (!credential) {
    console.error(
      "dist: 缺少公证凭据。在 shell profile 里配一组：\n" +
        "  APPLE_API_KEY（.p8 路径）+ APPLE_API_KEY_ID + APPLE_API_ISSUER（推荐）\n" +
        "  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID\n" +
        "  APPLE_KEYCHAIN_PROFILE\n" +
        "  只想出个只签名不公证的应急包：pnpm dist --no-notarize",
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

  const auth = notaryAuthArgs(credential, env);
  const history = capture("xcrun", ["notarytool", "history", "--output-format", "json", ...auth], 25_000);
  if (history.status !== 0) {
    const detail = history.out.trim().slice(0, 400);
    if (/\b401\b|\b403\b|unauthoriz|authentication|invalid.*(key|credential|token)/i.test(history.out)) {
      console.error(`dist: 公证凭据被 Apple 拒绝（notarytool history）：${detail}`);
      process.exit(1);
    }
    console.warn(`dist: 公证服务暂不可达，先继续构建（提交时会再试）：${detail}`);
  } else {
    console.log("dist: 公证服务可达（notarytool history 通过）");
  }
  return credential.kind;
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
/** 发版构建的签名信息；写入 build.json，并决定 verify-pack 是否断言签名 / 公证（`--dir` / Windows 为 null）。 */
let signing = null;

if (resume && dirOnly) {
  console.error("dist: --resume 不能和 --dir 一起用（续跑只用于正式产物）");
  process.exit(1);
}
if (resume && skipNotarize) {
  console.error("dist: --resume 与 --no-notarize 互斥");
  process.exit(1);
}
if (resume && !isMac) {
  console.error("dist: --resume 只用于 macOS 公证续跑");
  process.exit(1);
}

/**
 * `pnpm dist:resume`：公证失败 / 超时后复用已签好的 `.app`。
 *
 * 只补"公证 → staple → 打 dmg / zip"，不跑类型检查、构建与重签。
 * `--prepackaged` 让 electron-builder 跳过打包与签名（afterSign 也不会再触发），
 * 直接对已 staple 的 `.app` 生成产物——票据因此不会因为重新签名而失效。
 */
async function resumeBuild() {
  // 只认本流程留下的公证记录：否则会拿一份"碰巧在 release/ 里的旧 .app"去提交公证
  const state = readNotaryState(releaseDir);
  if (!state?.submissionId) {
    console.error(
      `dist: --resume 需要 ${join(releaseDir, "notary.json")}（上一次公证的 submission id）。\n` +
        "  只有 pnpm dist 在公证阶段失败 / 超时后才用它；完整构建请跑 pnpm dist",
    );
    process.exit(1);
  }
  const appOutDir = join(releaseDir, "mac-arm64");
  const recordedApp = typeof state.appPath === "string" && state.appPath.endsWith(".app") ? state.appPath : "";
  if (recordedApp && !existsSync(recordedApp)) {
    console.error(`dist: --resume 记录的 .app 不在了：${recordedApp}。重跑 pnpm dist`);
    process.exit(1);
  }
  if (!recordedApp && !existsSync(appOutDir)) {
    console.error(`dist: --resume 需要已签名的产物：${appOutDir} 不存在。先跑 pnpm dist`);
    process.exit(1);
  }
  const appName = recordedApp ? "" : readdirSync(appOutDir).find((name) => name.endsWith(".app"));
  if (!recordedApp && !appName) {
    console.error(`dist: --resume 在 ${appOutDir} 里找不到 .app。先跑 pnpm dist`);
    process.exit(1);
  }
  const appPath = recordedApp || join(appOutDir, appName);
  const identity = macIdentity();
  console.log(`dist: --resume 复用 ${appPath}（不重新构建、不重新签名）`);
  const next = await notarizeApp({ appPath, releaseDir });
  if (next?.status !== "Accepted" || !next?.stapledAt) {
    console.error("dist: 公证状态不是 Accepted 或票据没有 staple，中止");
    process.exit(1);
  }
  console.log("dist: 公证完成，用 --prepackaged 重打 dmg / zip");
  builderEnv.SQRAFT_SKIP_NOTARIZE = "1";
  run(process.execPath, [builderCli, "--mac", "--arm64", "--prepackaged", appPath], { env: builderEnv });
  return {
    ...identity,
    credential: notaryCredentialSource(process.env)?.kind ?? null,
    notarized: true,
    submissionId: next.submissionId,
    notarizedAt: next.stapledAt,
  };
}

if (isMac && resume) {
  signing = await resumeBuild();
} else {
  if (isMac && dirOnly) {
    // 快验路径：不签名、不公证。adhoc 签名由 after-pack 的 fuse 翻转自己补，
    // 保持 release/ 里的目录能跑；不写 build.json，release 也不会认它。
    builderFlags.push("-c.mac.notarize=false", "-c.mac.forceCodeSigning=false");
    builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    builderEnv.SQRAFT_SKIP_NOTARIZE = "1";
  } else if (isMac) {
    const identity = macIdentity();
    if (!NOTARIZE || skipNotarize) {
      const reason = skipNotarize ? "--no-notarize" : "NOTARIZE=false";
      console.log(
        `dist: 签名身份 ${identity.identity}${identity.teamId ? `（Team ${identity.teamId}）` : ""}；` +
          `${reason}：本轮只签名不公证（产物不能发版）`,
      );
      builderEnv.SQRAFT_SKIP_NOTARIZE = "1";
      signing = { ...identity, credential: null, notarized: false };
    } else {
      const credential = notaryPreflight(process.env);
      console.log(
        `dist: 签名身份 ${identity.identity}${identity.teamId ? `（Team ${identity.teamId}）` : ""}；` +
          `公证凭据 ${credential === "api-key" ? "App Store Connect API Key" : credential === "apple-id" ? "Apple ID 专用密码" : "keychain profile"}`,
      );
      signing = { ...identity, credential, notarized: true };
    }
  }

  console.log(`dist: ${process.platform} → electron-builder ${builderFlags.join(" ")}`);
  if (signing) {
    console.log(
      `dist: 接下来是签名${signing.notarized ? " → 公证 → staple" : ""}：嵌套 bundle 逐个签，` +
        "期间没有进度输出，通常 1–3 分钟（TSA 链路慢时可能到 8 分钟）。",
    );
  }
  run(process.execPath, [builderCli, ...builderFlags], { env: builderEnv });

  // afterSign 已经把公证结果写进 release/notary.json：这里只做交叉确认，避免钩子被跳过
  // （例如有人把 electron-builder.yml 的 afterSign 删了）还继续打出一个没公证的包。
  if (signing?.notarized) {
    const state = readNotaryState(releaseDir);
    if (state?.status !== "Accepted" || !state.stapledAt) {
      console.error(
        "dist: afterSign 没有留下已通过的公证状态（release/notary.json 缺失或未 staple）。\n" +
          "  检查 electron-builder.yml 的 afterSign 是否仍指向 scripts/after-sign.mjs",
      );
      process.exit(1);
    }
    signing = { ...signing, submissionId: state.submissionId, notarizedAt: state.stapledAt };
  }
}

// 成品防护验收（ADR-0030 / ADR-0034）：源码 / 依赖漏回包里、或包没签好 / 没公证，都在这里中止。
const verifyArgs = [join(desktopRoot, "scripts", "verify-pack.mjs")];
if (signing) {
  verifyArgs.push("--expect-signed");
  if (signing.teamId) verifyArgs.push("--team-id", signing.teamId);
  // 公证默认开启：Gatekeeper 接受 + 票据已 staple；只有 --no-notarize 才跳过这两条
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
    // macOS 发版带签名与公证信息；Windows 与 --dir 构建为 null。真正的结果由
    // verify-pack 断言，这里只用来让 release 拒绝"未签名 / 未公证 / 切换前的旧包"。
    signing,
    artifacts,
  };
  writeFileSync(join(releaseDir, "build.json"), `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  const signed = signing
    ? `，已签名（Team ${signing.teamId || "?"}）${signing.notarized ? "、已公证" : "、未公证"}`
    : "，未签名";
  console.log(
    `dist: 已写 build.json（${stamp.commit ? stamp.commit.slice(0, 7) : "no-git"}${stamp.dirty ? ", dirty" : ""}，` +
      `${artifacts.length} 个产物${signed}）`,
  );
}
