/**
 * 公证（ADR-0034 / 2026-11-22 修订）：提交、轮询、staple。
 *
 * 为什么不用 electron-builder 内建的 `mac.notarize`：它内部是 `notarytool submit --wait`，
 * 全程没有输出、超时不可控。2026-11-13 两次提交在 Apple 侧各挂约 24 小时，构建看起来像卡死，
 * 这正是当时把公证整体关掉的原因。这里自己 submit + info 轮询：
 * 每 20 秒一行状态、60 分钟硬上限，失败时把 submission id 与 `notarytool log` 的问题列表打出来；
 * 状态落到 `release/notary.json`，`pnpm dist:resume` 能接着走，不需要重新构建。
 *
 * 顺序约束：票据必须 staple 进 `.app`，再让 electron-builder 打 dmg / zip，
 * 所以调用点是 `afterSign` 钩子（见 `after-sign.mjs`），不是 dist 的末尾。
 *
 * 纯函数（参数拼装、状态判定、状态文件解析、续跑计划）单独导出，便于单测。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { notaryCredentialSource } from "./release-utils.mjs";

/** 轮询上限：Apple 处理通常 1–5 分钟；超过一小时就是异常，宁可失败也不要静默挂一天。 */
export const NOTARY_TIMEOUT_MS = 60 * 60 * 1000;
/** 状态轮询间隔：notarytool 本身有调用开销，20 秒既够及时又不会打爆接口。 */
export const NOTARY_POLL_MS = 20 * 1000;
/** 续跑用的状态文件名（在 `release/` 下，release.mjs 不会上传它）。 */
export const NOTARY_STATE_FILE = "notary.json";

/** notarytool 的终态：只有 Accepted 算成功。 */
const FAILURE_STATUSES = new Set(["Invalid", "Rejected"]);
const KNOWN_STATUSES = ["Accepted", "In Progress", "Invalid", "Rejected", "Pending"];

/* ---------- 纯函数 ---------- */

/**
 * notarytool 的鉴权参数（与 `notaryCredentialSource()` 一一对应）。
 *
 * `.p8` 路径随凭据对象传，id / issuer 从 env 读；半套变量在这里直接报错，
 * 不能让 notarytool 拿着空参数去请求（错误信息会变成没用的 401）。
 */
export function notaryAuthArgs(credential, env = {}) {
  if (!credential) throw new Error("notarize: 缺少公证凭据");
  if (credential.kind === "incomplete") throw new Error(`notarize: 公证凭据不完整——${credential.detail}`);
  if (credential.kind === "api-key") {
    const keyId = env.APPLE_API_KEY_ID ?? "";
    const issuer = env.APPLE_API_ISSUER ?? "";
    if (!credential.keyPath || !keyId || !issuer) {
      throw new Error("notarize: App Store Connect API Key 三件套不全");
    }
    return ["--key", credential.keyPath, "--key-id", keyId, "--issuer", issuer];
  }
  if (credential.kind === "apple-id") {
    return [
      "--apple-id",
      env.APPLE_ID ?? "",
      "--password",
      env.APPLE_APP_SPECIFIC_PASSWORD ?? "",
      "--team-id",
      env.APPLE_TEAM_ID ?? "",
    ];
  }
  if (credential.kind === "keychain-profile") {
    return ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE ?? ""];
  }
  throw new Error(`notarize: 不认识的公证凭据类型 ${String(credential.kind)}`);
}

/**
 * notarytool 的 JSON 输出可能夹着进度行（"Conducting pre-submission checks…"），
 * 所以先直接 parse，失败再截第一个 `{` 到最后一个 `}` 重试。
 */
export function parseNotaryJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    // 继续尝试从混杂输出里截 JSON
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 统一成 notarytool 的写法（大小写不一致时也能判定）。 */
export function normalizeNotaryStatus(value) {
  const status = String(value ?? "").trim();
  if (!status) return "Unknown";
  return KNOWN_STATUSES.find((item) => item.toLowerCase() === status.toLowerCase()) ?? status;
}

export function isNotaryAccepted(status) {
  return normalizeNotaryStatus(status) === "Accepted";
}

export function isNotaryFailure(status) {
  return FAILURE_STATUSES.has(normalizeNotaryStatus(status));
}

export function isNotaryTimedOut(startedAtMs, nowMs, timeoutMs = NOTARY_TIMEOUT_MS) {
  return nowMs - startedAtMs >= timeoutMs;
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/** `notary.json` 读不出来时当作不存在：宁可重新提交，也不要拿半个状态去续跑。 */
export function parseNotaryState(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * 续跑计划：只回答"下一步做什么"，不碰网络与文件系统。
 *
 * - 没有 id / 不是同一个 .app（CDHash 变了）/ 没有 CDHash 记录 → 重新提交；
 * - 已 Accepted 且 stapledAt 存在 → 完成（staple 不改 CDHash，重复执行也安全）；
 * - 已 Accepted 但没有 staple → 只补 staple；
 * - Invalid / Rejected → 失败（摘日志，不要重复提交同一个包）；
 * - 其余（In Progress 等）→ 继续轮询。
 */
export function planNotarization({ state, appPath, cdHash }) {
  if (!state?.submissionId || state.appPath !== appPath) return { action: "submit" };
  if (state.cdHash && cdHash && state.cdHash !== cdHash) return { action: "submit" };
  if (isNotaryAccepted(state.status)) {
    return state.stapledAt ? { action: "done" } : { action: "staple", submissionId: state.submissionId };
  }
  if (isNotaryFailure(state.status)) return { action: "failed", submissionId: state.submissionId };
  return { action: "poll", submissionId: state.submissionId };
}

/** 把 `notarytool log` 的 issues 压成几行人话；没有 issues 时返回空数组。 */
export function summarizeNotaryLog(text) {
  const json = parseNotaryJson(text);
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  return issues.slice(0, 10).map((issue) => {
    const where = issue?.path ? `（${String(issue.path)}）` : "";
    const level = issue?.severity ? String(issue.severity) : "error";
    const message = String(issue?.message ?? issue?.code ?? "").trim();
    return `[${level}] ${message}${where}`;
  });
}

/* ---------- 状态文件 ---------- */

export function readNotaryState(releaseDir) {
  const file = join(releaseDir, NOTARY_STATE_FILE);
  if (!existsSync(file)) return null;
  try {
    return parseNotaryState(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeNotaryState(releaseDir, state) {
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, NOTARY_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/* ---------- 副作用 ---------- */

function xcrun(args, timeout = 120_000) {
  const result = spawnSync("xcrun", args, { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
  return {
    status: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    error: result.error,
  };
}

function notarytool(args, timeout = 120_000) {
  return xcrun(["notarytool", ...args], timeout);
}

function stapler(args) {
  return xcrun(["stapler", ...args], 5 * 60_000);
}

/** 签名指纹：staple 不会改变它，重新签名 / 重新构建一定会变，用来判断 notary.json 是否属于这个包。 */
function codeHashOf(appPath) {
  const result = spawnSync("codesign", ["-d", "--verbose=4", appPath], { encoding: "utf8" });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return text.match(/^CDHash=(.+)$/m)?.[1]?.trim() ?? "";
}

function fail(message) {
  throw new Error(message);
}

function printNotaryLog(submissionId, auth, log) {
  const result = notarytool(["log", submissionId, "--output-format", "json", ...auth]);
  const lines = summarizeNotaryLog(result.out);
  if (lines.length === 0) {
    log(`notarize: notarytool log ${submissionId} 没有给出问题列表（退出码 ${result.status}）`);
    return;
  }
  log(`notarize: notarytool log ${submissionId} 的问题：`);
  for (const line of lines) log(`  - ${line}`);
}

/** 提交一个临时 zip（Apple 只收 zip / dmg / pkg）；返回 submission id 与初始状态。 */
function submitApp({ appPath, auth, log }) {
  const tempDir = mkdtempSync(join(tmpdir(), "sqraft-notary-"));
  const zipPath = join(tempDir, `${basename(appPath, ".app")}.zip`);
  try {
    const zip = spawnSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath], {
      encoding: "utf8",
    });
    if (zip.status !== 0) {
      fail(`notarize: 压缩 .app 失败（ditto exit ${zip.status ?? -1}）：${zip.stderr ?? ""}`);
    }
    // 上传整个应用包，慢网下 2 分钟不够；spawnSync 的 timeout 只用于兜底
    const submitted = notarytool(["submit", zipPath, "--output-format", "json", ...auth], 15 * 60_000);
    const parsed = parseNotaryJson(submitted.out);
    const submissionId = String(parsed?.id ?? "").trim();
    if (!submissionId) {
      fail(
        `notarize: 提交没有返回 submission id（notarytool exit ${submitted.status}）：` +
          submitted.out.slice(0, 500),
      );
    }
    const status = normalizeNotaryStatus(parsed?.status);
    log(`notarize: 已提交 ${submissionId}（${status}），开始轮询`);
    return { submissionId, status };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** 轮询到终态；每轮把状态回写给调用方（写 notary.json）。 */
async function waitForAcceptance({ submissionId, auth, log, pollMs, timeoutMs, onState }) {
  const startedAt = Date.now();
  let status = "In Progress";
  for (;;) {
    const info = notarytool(["info", submissionId, "--output-format", "json", ...auth]);
    if (info.status !== 0) {
      fail(
        `notarize: 查询 ${submissionId} 失败（notarytool exit ${info.status}）：${info.out.slice(0, 400)}\n` +
          "  网络恢复后跑 pnpm dist:resume，不用重新构建",
      );
    }
    status = normalizeNotaryStatus(parseNotaryJson(info.out)?.status);
    onState(status);
    if (isNotaryAccepted(status)) return status;
    if (isNotaryFailure(status)) return status;
    if (isNotaryTimedOut(startedAt, Date.now(), timeoutMs)) {
      fail(
        `notarize: 提交 ${submissionId} 在 ${formatDuration(timeoutMs)} 内没有结束（最后状态 ${status}）。\n` +
          `  查询：xcrun notarytool info ${submissionId} <凭据参数>\n` +
          "  续跑：pnpm dist:resume（复用已签好的 .app，不重新构建）",
      );
    }
    log(`notarize: ${submissionId} ${status}（已等 ${formatDuration(Date.now() - startedAt)}）`);
    await delay(pollMs);
  }
}

/**
 * 把已签名的 `.app` 公证并 staple。
 *
 * `log` 只接一行字符串，方便 afterSign 与 dist 复用同一套输出；
 * `env` 显式传入，便于单测与"换一套凭据"的排障。
 */
export async function notarizeApp({
  appPath,
  releaseDir,
  env = process.env,
  log = (line) => console.log(line),
  pollMs = NOTARY_POLL_MS,
  timeoutMs = NOTARY_TIMEOUT_MS,
}) {
  const absoluteApp = resolve(appPath);
  if (!existsSync(absoluteApp)) fail(`notarize: 找不到 .app：${absoluteApp}`);

  const cdHash = codeHashOf(absoluteApp);
  const state = readNotaryState(releaseDir);
  const plan = planNotarization({ state, appPath: absoluteApp, cdHash });

  if (plan.action === "done") {
    log(`notarize: ${NOTARY_STATE_FILE} 显示已公证并 staple（${state.submissionId}），跳过`);
    return state;
  }

  const credential = notaryCredentialSource(env);
  if (!credential) {
    fail(
      "notarize: 缺少公证凭据。配一组环境变量（APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER），" +
        "或 APPLE_ID 三件套 / APPLE_KEYCHAIN_PROFILE",
    );
  }
  const auth = notaryAuthArgs(credential, env);

  if (plan.action === "failed") {
    printNotaryLog(plan.submissionId, auth, log);
    fail(`notarize: 提交 ${plan.submissionId} 被判失败。修正上面的问题后重跑 pnpm dist`);
  }

  const submittedAt =
    plan.action === "submit"
      ? new Date().toISOString()
      : (state?.submittedAt ?? new Date().toISOString());
  let submissionId = plan.action === "poll" || plan.action === "staple" ? plan.submissionId : "";
  let status = plan.action === "staple" ? "Accepted" : normalizeNotaryStatus(state?.status);

  if (plan.action === "submit") {
    const submitted = submitApp({ appPath: absoluteApp, auth, log });
    submissionId = submitted.submissionId;
    status = submitted.status;
    writeNotaryState(releaseDir, {
      submissionId,
      status,
      appPath: absoluteApp,
      cdHash,
      submittedAt,
    });
  } else if (plan.action === "poll") {
    log(`notarize: 续跑提交 ${submissionId}（上次状态 ${status}）`);
  }

  if (!isNotaryAccepted(status)) {
    const finalStatus = await waitForAcceptance({
      submissionId,
      auth,
      log,
      pollMs,
      timeoutMs,
      onState: (next) => {
        status = next;
        writeNotaryState(releaseDir, {
          submissionId,
          status,
          appPath: absoluteApp,
          cdHash,
          submittedAt,
        });
      },
    });
    if (isNotaryFailure(finalStatus)) {
      printNotaryLog(submissionId, auth, log);
      fail(`notarize: 提交 ${submissionId} 的结果是 ${finalStatus}。修正上面的问题后重跑 pnpm dist`);
    }
  }

  log(`notarize: ${submissionId} 已 Accepted，staple 到 ${basename(absoluteApp)}`);
  const staple = stapler(["staple", absoluteApp]);
  if (staple.status !== 0) {
    fail(
      `notarize: staple 失败（exit ${staple.status}）：${staple.out.slice(0, 400)}\n` +
        "  跑 pnpm dist:resume 可以只补 staple，不用重新构建",
    );
  }
  const validate = stapler(["validate", absoluteApp]);
  if (validate.status !== 0) {
    fail(`notarize: 票据校验失败（exit ${validate.status}）：${validate.out.slice(0, 400)}`);
  }

  const done = {
    submissionId,
    status: "Accepted",
    appPath: absoluteApp,
    // staple 之后再取一次指纹：无论 stapler 是否改动 bundle，续跑时都能对上同一个值
    cdHash: codeHashOf(absoluteApp),
    submittedAt,
    stapledAt: new Date().toISOString(),
  };
  writeNotaryState(releaseDir, done);
  log(`notarize: 完成（提交 ${submissionId}，票据已 staple）`);
  return done;
}

/* ---------- 手工调用：node scripts/notarize.mjs <Sqraft.app> ---------- */

const invokedDirectly =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const appArg = process.argv[2];
  if (!appArg) {
    console.error("用法：node scripts/notarize.mjs <Sqraft.app>（状态写在 release/notary.json）");
    process.exit(1);
  }
  const releaseDir = resolve(process.argv[3] ?? join(process.cwd(), "release"));
  notarizeApp({ appPath: resolve(appArg), releaseDir }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
