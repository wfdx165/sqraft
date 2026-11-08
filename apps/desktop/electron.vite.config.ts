import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

/**
 * 三个入口各自独立构建：主进程、preload、渲染层。
 * 渲染层继续用别名直连三个包的源码，改包代码不需要单独构建。
 *
 * 构建期防护（ADR-0030）：三个入口都压缩；sourcemap 生成但不写
 * `//# sourceMappingURL` 注释。`out/` 里的 `.map` 由
 * `scripts/archive-sourcemaps.mjs` 归档到 `release/sourcemaps/<version>/`，
 * 再被 `electron-builder.yml` 的 `!out/**\/*.map` 排除出 asar——
 * 成品里只有压缩后的 bundle，线上崩溃栈靠归档还原。
 */
const hardenedBuild = {
  minify: "esbuild",
  sourcemap: "hidden",
} as const;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: hardenedBuild,
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: hardenedBuild,
  },
  renderer: {
    plugins: [vue()],
    build: hardenedBuild,
    resolve: {
      alias: {
        "@sqraft/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
        "@sqraft/render": fileURLToPath(new URL("../../packages/render/src/index.ts", import.meta.url)),
        "@sqraft/ai-tools": fileURLToPath(new URL("../../packages/ai-tools/src/index.ts", import.meta.url)),
      },
    },
  },
});
