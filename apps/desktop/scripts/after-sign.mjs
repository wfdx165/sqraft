/**
 * electron-builder `afterSign` 钩子：签名之后、打 dmg / zip 之前做公证（ADR-0034）。
 *
 * 为什么挂在 afterSign：公证票据必须 staple 进 `.app`，再让 electron-builder
 * 把它打进 dmg 与自动更新用的 zip；放到 dist 末尾就晚了（包里的 `.app` 没有票据）。
 *
 * 跳过路径只有一条：`SQRAFT_SKIP_NOTARIZE=1`（由 `pnpm dist --no-notarize` 与
 * `pnpm dist:dir` 设置）。跳过的产物在 build.json 里记 `notarized:false`，`pnpm release` 拒收。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { notarizeApp } from "./notarize.mjs";

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.SQRAFT_SKIP_NOTARIZE === "1") {
    console.log("[after-sign] SQRAFT_SKIP_NOTARIZE=1：跳过公证（产物不能发版）");
    return;
  }
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!existsSync(appPath)) throw new Error(`[after-sign] 找不到 ${appPath}`);
  // outDir 是 release/（electron-builder 的 output 目录）；拿不到时按 mac-arm64 的上一级兜底
  const releaseDir = context.outDir ? resolve(context.outDir) : resolve(context.appOutDir, "..", "..");
  await notarizeApp({ appPath, releaseDir });
}
