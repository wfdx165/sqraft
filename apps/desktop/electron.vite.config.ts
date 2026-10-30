import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

/**
 * 三个入口各自独立构建：主进程、preload、渲染层。
 * 渲染层继续用别名直连三个包的源码，改包代码不需要单独构建。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: {
        "@sqraft/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
        "@sqraft/render": fileURLToPath(new URL("../../packages/render/src/index.ts", import.meta.url)),
        "@sqraft/ai-tools": fileURLToPath(new URL("../../packages/ai-tools/src/index.ts", import.meta.url)),
      },
    },
  },
});
