/**
 * 打包后、签名前的 macOS 收敛（electron-builder afterPack）：
 *
 * 1. 删掉 Electron 默认注入、本应用根本用不到的权限文案——权限请求在
 *    `main/index.ts` 里一律拒绝，一个权限都不申请，留着反而让人以为这 app 要摄像头；
 * 2. helper 进程的 `CFBundleName` 改成产品名：bundle 文件名已是 `Sqraft Helper …`，
 *    只有 plist 里还留着运行时厂商默认名，活动监视器与崩溃报告里看得见；
 * 3. 翻转 Electron fuse（ADR-0030）：关掉"以 Node 跑主进程"、"从环境变量注入 Node 参数"、
 *    "附带调试参数启动"，要求只能从 asar 加载应用代码。
 *
 * 只在 darwin 执行（Windows/Linux 没有这些键）；签名发生在 afterPack 之后，改完会被正常重签。
 * 不碰 `Electron Framework.framework` 的标识与 `NSPrincipalClass`——那两处是运行时正确性依赖。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";

/** 这 app 一个权限都不用：请求一律拒绝，文案没有存在的理由 */
const UNUSED_PERMISSION_KEYS = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSSystemAdministrationUsageDescription",
  "NSAppleEventsUsageDescription",
];

function runPlutil(args) {
  execFileSync("plutil", args, { stdio: "pipe" });
}

/**
 * fuse 配置（ADR-0030）。
 *
 * - `strictlyRequireAllFuses`：Electron 升级新增 fuse 时直接构建失败，逼着我们复核一次，
 *   而不是默默继承默认值。
 * - `resetAdHocDarwinSignature`：翻 fuse 会改主二进制、破坏 adhoc 签名，arm64 上
 *   macOS 会拒绝启动未签名的主二进制；这里让 fuses 自己补一遍 adhoc。
 * - `EnableEmbeddedAsarIntegrityValidation` 保持关：哈希写在 `Info.plist` 里，
 *   未签名时改包的人顺手就能改，开了只增加一个构建失败点。
 * - `GrantFileProtocolExtraPrivileges` 保持开：生产环境用 `file://` 加载渲染层。
 */
const FUSE_CONFIG = {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: true,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableCookieEncryption]: false,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  // Electron 45 新增（@electron/fuses 2.x）；保持默认开启，关掉会影响 WebAssembly 的 trap 处理
  [FuseV1Options.WasmTrapHandlers]: true,
};

function removeKey(plist, key) {
  try {
    runPlutil(["-remove", key, plist]);
    return true;
  } catch {
    return false; // 键本来就不在
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const product = context.packager.appInfo.productFilename;
  const appPath = join(context.appOutDir, `${product}.app`);
  const mainPlist = join(appPath, "Contents", "Info.plist");

  const removed = UNUSED_PERMISSION_KEYS.filter((key) => removeKey(mainPlist, key));

  const frameworks = join(appPath, "Contents", "Frameworks");
  const renamed = [];
  for (const entry of readdirSync(frameworks)) {
    if (!entry.endsWith(".app")) continue;
    const plist = join(frameworks, entry, "Contents", "Info.plist");
    if (!existsSync(plist)) continue;
    const name = entry.replace(/\.app$/, "");
    try {
      runPlutil(["-replace", "CFBundleName", "-string", name, plist]);
      renamed.push(name);
    } catch (error) {
      console.warn(`[after-pack] CFBundleName 更新失败 ${entry}: ${String(error)}`);
    }
  }

  console.log(`[after-pack] 权限文案移除 ${removed.length} 条；helper 显示名 ${renamed.length} 个`);

  const binary = join(appPath, "Contents", "MacOS", product);
  if (!existsSync(binary)) throw new Error(`[after-pack] 找不到主二进制：${binary}`);
  await flipFuses(binary, FUSE_CONFIG);
  console.log("[after-pack] fuse 已翻转（RunAsNode / NODE_OPTIONS / 调试参数 关闭，仅从 asar 加载）");
}
