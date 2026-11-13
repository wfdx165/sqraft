/**
 * 发布脚本共用的小工具（纯函数，便于单测）。
 *
 * 抽出来是为了让 release.mjs 与 stage-update.mjs 对"哪个文件才算 arm64 产物"
 * 只有一个答案——macOS zip 的默认文件名带 -mac，曾经两边各写一套导致漂移。
 */

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

/** electron-builder 的 macOS zip 默认带 -mac；两种后缀都认。 */
export function pickArm64Zip(names, version) {
  const suffixes = [`-${version}-arm64.zip`, `-${version}-arm64-mac.zip`];
  return names.find((name) => suffixes.some((suffix) => name.endsWith(suffix))) ?? null;
}

export function pickArm64Dmg(names, version) {
  return names.find((name) => name.endsWith(`-${version}-arm64.dmg`)) ?? null;
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
 * verify-pack 的命令行解析：位置参数是产物路径，其余是开关。
 *
 * 返回 `{ target, expectSigned, expectedTeam }` 或 `{ error }`。`--team-id` 缺值必须报错——
 * 静默退化成空串会让 Team 比对被跳过、脚本仍报"通过"。
 */
export function parseVerifyPackArgs(argv) {
  let target = null;
  let expectSigned = false;
  let expectedTeam = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--expect-signed") {
      expectSigned = true;
    } else if (arg === "--team-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        return { error: "--team-id 需要一个 Team ID（10 位），不能为空" };
      }
      expectedTeam = value;
      i++;
    } else if (arg.startsWith("--")) {
      return { error: `不认识的参数 ${arg}` };
    } else if (target == null) {
      target = arg;
    } else {
      return { error: `只能指定一个产物路径（多余：${arg}）` };
    }
  }
  return { target, expectSigned, expectedTeam };
}
