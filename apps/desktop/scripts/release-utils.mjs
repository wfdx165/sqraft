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
