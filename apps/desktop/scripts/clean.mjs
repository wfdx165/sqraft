/**
 * 打包前的清理：删掉 `out/`（electron-vite 产物）与 `release/`（electron-builder 产物）。
 *
 * 为什么要清：
 * - `electron-builder.yml` 的 `files` 是 `out/` 整个目录，某个入口被删掉后残留的旧文件会被打进 asar；
 * - electron-builder 只覆盖同名文件，旧版本号 / 旧平台的 dmg 会一直堆在 `release/`。
 *
 * 只挂在 dist 链路上，不挂 build：dev 期间跑 build 会删掉正在用的 `out/main/index.js`。
 * `--keep-release` 只清 `out/`，保留上一次的 dmg（新构建失败时不至于什么都不剩）。
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keepRelease = process.argv.includes("--keep-release");
const targets = keepRelease ? ["out"] : ["out", "release"];

/** 目录体量（打包产物里有上万个文件，只数不读）。 */
function sizeOf(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += sizeOf(child);
    else total += statSync(child).size;
  }
  return total;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${bytes} B`;
}

const removed = [];
for (const name of targets) {
  const path = join(packageRoot, name);
  let size;
  try {
    size = sizeOf(path);
  } catch {
    continue; // 目录不存在：没什么可删
  }
  rmSync(path, { recursive: true, force: true });
  removed.push(`${name}/ (${formatSize(size)})`);
}

console.log(removed.length > 0 ? `clean: 删除 ${removed.join("、")}` : "clean: 没有需要清理的目录");
