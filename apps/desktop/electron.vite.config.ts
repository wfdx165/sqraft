import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

/**
 * 三个入口各自独立构建：主进程、preload、渲染层。
 * 渲染层继续用别名直连三个包的源码，改包代码不需要单独构建。
 *
 * 构建期防护（ADR-0030）：三个入口都压缩，且不生成 sourcemap。
 * 线上堆栈默认不可读；需要排障时按 release tag 检出代码、临时打开
 * sourcemap 重建，不保留归档。
 */
const hardenedBuild = {
  minify: "esbuild",
  sourcemap: false,
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
