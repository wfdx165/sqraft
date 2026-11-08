/**
 * 归档本次构建的 sourcemap（ADR-0030）。
 *
 * 压缩后的 bundle 配 `sourcemap: "hidden"`：`.map` 会生成在 `out/` 里，
 * 但不带 `//# sourceMappingURL` 注释，并在打包时被 electron-builder 排除。
 * 它们必须**在构建成功后立刻**搬出 `out/`——`pnpm dist` 下次开头就 clean，
 * 归档晚一步就等于永久丢失那个版本的排障能力。
 *
 * 落点：`release/sourcemaps/v<version>/<out 内的相对路径>`。
 * 不进 git、不上传、不进 asar；`release/` 本来就被 `clean.mjs` 管理。
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(packageRoot, "out");
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
const targetDir = join(packageRoot, "release", "sourcemaps", `v${version}`);

/** 递归收集 `.map`，保留 `out/` 内的相对路径，避免同名 chunk 互相覆盖。 */
function collectMaps(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectMaps(path, found);
    else if (entry.name.endsWith(".map")) found.push(path);
  }
  return found;
}

let maps;
try {
  maps = collectMaps(outDir);
} catch {
  console.error(`sourcemap: 找不到 ${outDir}，请先构建`);
  process.exit(1);
}

if (maps.length === 0) {
  console.error("sourcemap: out/ 里没有任何 .map——sourcemap 配置被改坏了吗？（ADR-0030 要求 hidden sourcemap）");
  process.exit(1);
}

let total = 0;
for (const source of maps) {
  const destination = join(targetDir, relative(outDir, source));
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  total += statSync(source).size;
}

console.log(
  `sourcemap: 归档 ${maps.length} 个文件（${(total / 1024).toFixed(0)} kB）到 ${relative(packageRoot, targetDir)}/`,
);
