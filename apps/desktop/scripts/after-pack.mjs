/**
 * 打包后、签名前的 macOS 收敛（electron-builder afterPack）：
 *
 * 1. 删掉 Electron 默认注入、本应用根本用不到的权限文案——权限请求在
 *    `main/index.ts` 里一律拒绝，一个权限都不申请，留着反而让人以为这 app 要摄像头；
 * 2. helper 进程的 `CFBundleName` 改成产品名：bundle 文件名已是 `Sqraft Helper …`，
 *    只有 plist 里还留着运行时厂商默认名，活动监视器与崩溃报告里看得见。
 *
 * 只在 darwin 执行（Windows/Linux 没有这些键）；签名发生在 afterPack 之后，改完会被正常重签。
 * 不碰 `Electron Framework.framework` 的标识与 `NSPrincipalClass`——那两处是运行时正确性依赖。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
}
