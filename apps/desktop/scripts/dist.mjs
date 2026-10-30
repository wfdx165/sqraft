/**
 * 按当前系统选择打包命令：
 * - macOS：arm64 dmg（本项目只在 Apple Silicon 上验证过）
 * - Windows：nsis 安装包
 * - Linux：AppImage
 *
 * 交叉打包不在这里做：macOS 上打 Windows/Linux 包需要 wine / docker，
 * 需要时请显式执行 `pnpm run dist:win` / `dist:linux` 并自行准备环境。
 */
import { spawnSync } from "node:child_process";

const scriptByPlatform = {
  darwin: "dist:mac",
  win32: "dist:win",
  linux: "dist:linux",
};

const script = scriptByPlatform[process.platform];
if (!script) {
  console.error(`不支持的平台：${process.platform}`);
  process.exit(1);
}

const result = spawnSync("pnpm", ["run", script], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
