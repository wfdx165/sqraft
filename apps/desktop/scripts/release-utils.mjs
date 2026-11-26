/**
 * 发布脚本共用的小工具（纯函数，便于单测）。
 *
 * 抽出来是为了让 dist / release / stage-update 对"哪个文件才是某个架构的产物"
 * 只有一个答案——macOS 的 dmg / zip 命名与输出目录都按架构区分（ADR-0046）。
 */

/** macOS 支持的两个架构；顺序固定，脚本输出与清单都按这个顺序。 */
export const MAC_ARCHES = ["arm64", "x64"];

/** electron-builder 的 macOS 输出目录：arm64 → `mac-arm64`，x64 → `mac`。 */
export function macOutDirName(arch) {
  if (!MAC_ARCHES.includes(arch)) throw new Error(`未知架构 ${arch}`);
  return arch === "arm64" ? "mac-arm64" : "mac";
}

/** 从 `.app` 路径反推架构（`release/mac-arm64/...` 或 `release/mac/...`）。 */
export function archFromAppPath(appPath) {
  return /[\\/]mac-arm64[\\/]/.test(appPath) ? "arm64" : "x64";
}

/**
 * `dist:resume` 的逐架构计划（纯函数，便于单测）。三种动作：
 * - build：连已签名的 `.app` 都没有——上一个架构公证失败时，本架构压根没构建；
 * - notarize：`.app` 在，但公证状态不是 Accepted + staple（提交就失败过，或从没提交）；
 * - repack：已公证，只重打 dmg / zip。
 *
 * `appExists(arch)` 由调用方注入，这里不碰文件系统。
 */
export function planResumeArches({ states = {}, appExists = () => false }) {
  return MAC_ARCHES.map((arch) => {
    const state = states[arch];
    if (!appExists(arch)) return { arch, action: "build" };
    if (state?.status !== "Accepted" || !state?.stapledAt) return { arch, action: "notarize" };
    return { arch, action: "repack" };
  });
}

/** 只处理 x.y.z；容忍 v 前缀。 */
export function compareVersions(a, b) {
  const parse = (value) =>
    value.trim().replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 上一版公开支持的 macOS 地板（ADR-0046 / ADR-0049）。
 *
 * 只有正式宣布停止支持 11.7 时才改它；不能用当前 build 的下限代替，
 * 否则“抬了下限却没填 minOS”的检查会永远通过。
 */
export const MACOS_BASELINE = "11.0";

const MIN_OS_PATTERN = /^\d+(?:\.\d+){0,2}$/;

/**
 * 校验 `update.config.json` 的 `minOS`：缺省/null = 不填；字符串必须是 x.y[.z]。
 * 返回规范化后的字符串或 null；非法值直接抛错，让 release 在预检阶段中止。
 */
export function normalizeMinOS(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !MIN_OS_PATTERN.test(value.trim())) {
    throw new Error(`minOS 必须是 "12.0" 形式的 macOS 版本，收到 ${JSON.stringify(value)}`);
  }
  return value.trim();
}

/**
 * `minOS` 与两个架构的 `LSMinimumSystemVersion` 交叉校验：
 * - 两个架构的 floor 必须一致；
 * - 抬了 floor 却没填 `minOS` → 老系统用户会下载到装不上的包；
 * - `minOS` 低于 floor → 清单会放行装不上的系统。
 * 返回问题列表；空数组 = 通过。
 */
export function minOSProblems({ minOS, floors }) {
  const unique = [...new Set(floors)];
  if (unique.length !== 1) {
    return [`两个架构的 LSMinimumSystemVersion 不一致：${floors.join(" / ")}`];
  }
  const floor = unique[0];
  if (!minOS) {
    return compareVersions(floor, MACOS_BASELINE) > 0
      ? [`app 下限已抬到 ${floor}，但 update.config.json 的 minOS 为空；老系统用户会下载到装不上的包`]
      : [];
  }
  return compareVersions(minOS, floor) < 0
    ? [`minOS ${minOS} 低于 app 的 LSMinimumSystemVersion ${floor}`]
    : [];
}

/** macOS 产物命名：`Sqraft-<version>-<arch>.dmg` / `.zip`（见 electron-builder.yml 的 artifactName）。 */
export function pickMacDmg(names, version, arch) {
  return names.find((name) => name.endsWith(`-${version}-${arch}.dmg`)) ?? null;
}

export function pickMacZip(names, version, arch) {
  const suffixes = [`-${version}-${arch}.zip`];
  // 0.1.1 及以前只有 arm64，zip 默认名带 -mac；保留兼容，避免旧产物认不出来
  if (arch === "arm64") suffixes.push(`-${version}-arm64-mac.zip`);
  return names.find((name) => suffixes.some((suffix) => name.endsWith(suffix))) ?? null;
}

/** Windows NSIS 安装包：`Sqraft-Setup-0.0.5.exe`（见 electron-builder.yml 的 artifactName）。 */
export function pickWinSetup(names, version) {
  return names.find((name) => name.endsWith(`-Setup-${version}.exe`)) ?? null;
}

/**
 * 公证凭据来源（ADR-0034）：与 electron-builder 内建公证读取的是同一组环境变量。
 *
 * 只认完整的两组或 keychain profile；**半套变量比没有更糟**——electron-builder 会静默跳过
 * 公证，所以这里单独返回 `incomplete` 让 dist 直接报错。入参是 env（不是 process.env），
 * 便于单测。
 */
export function notaryCredentialSource(env = {}) {
  const apiKey = Boolean(env.APPLE_API_KEY);
  const apiKeyId = Boolean(env.APPLE_API_KEY_ID);
  const apiIssuer = Boolean(env.APPLE_API_ISSUER);
  if (apiKey || apiKeyId || apiIssuer) {
    if (!(apiKey && apiKeyId && apiIssuer)) {
      return {
        kind: "incomplete",
        detail: "APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER 三件套不全",
      };
    }
    return { kind: "api-key", keyPath: env.APPLE_API_KEY };
  }
  const appleId = Boolean(env.APPLE_ID);
  const password = Boolean(env.APPLE_APP_SPECIFIC_PASSWORD);
  const teamId = Boolean(env.APPLE_TEAM_ID);
  if (appleId || password || teamId) {
    if (!(appleId && password && teamId)) {
      return {
        kind: "incomplete",
        detail: "APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID 三件套不全",
      };
    }
    return { kind: "apple-id" };
  }
  if (env.APPLE_KEYCHAIN_PROFILE) return { kind: "keychain-profile" };
  return null;
}

/**
 * build.json 的签名 / 公证闸门（纯函数）。
 *
 * 公证默认开启后，`notarized !== true` 一律拒收：`--no-notarize` 的应急包
 * 只能留在本机自测，不能发出去——否则 README 承诺的"双击即开"会被自己打破。
 */
export function signingProblems(signing) {
  if (!signing || !signing.identity || !signing.teamId) {
    return [
      "build.json 里没有完整的签名信息：那是 dist:dir 或签名上线前的产物。" +
        "发版请重跑 pnpm dist（需要 Developer ID 证书）",
    ];
  }
  if (signing.notarized !== true) {
    return [
      "build.json 里 signing.notarized 不是 true：这份产物没有公证（可能是 --no-notarize 的应急包）。" +
        "发版请重跑 pnpm dist（需要 Apple 公证凭据）",
    ];
  }
  return [];
}

/**
 * verify-pack 的命令行解析：位置参数是产物路径，其余是开关。
 *
 * 返回 `{ target, expectSigned, expectNotarized, expectedTeam, expectedArch }` 或 `{ error }`。
 * `--team-id` / `--arch` 缺值必须报错——静默退化会让对应断言被跳过、脚本仍报"通过"。
 */
export function parseVerifyPackArgs(argv) {
  let target = null;
  let expectSigned = false;
  let expectNotarized = false;
  let expectedTeam = "";
  let expectedArch = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--expect-signed") {
      expectSigned = true;
    } else if (arg === "--expect-notarized") {
      expectNotarized = true;
    } else if (arg === "--team-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        return { error: "--team-id 需要一个 Team ID（10 位），不能为空" };
      }
      expectedTeam = value;
      i++;
    } else if (arg === "--arch") {
      const value = argv[i + 1];
      if (!MAC_ARCHES.includes(value)) {
        return { error: `--arch 只认 ${MAC_ARCHES.join(" / ")}（收到 ${value ?? "空"}）` };
      }
      expectedArch = value;
      i++;
    } else if (arg.startsWith("--")) {
      return { error: `不认识的参数 ${arg}` };
    } else if (target == null) {
      target = arg;
    } else {
      return { error: `只能指定一个产物路径（多余：${arg}）` };
    }
  }
  return { target, expectSigned, expectNotarized, expectedTeam, expectedArch };
}
