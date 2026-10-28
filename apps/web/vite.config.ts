import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@sqraft/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@sqraft/render": fileURLToPath(new URL("../../packages/render/src/index.ts", import.meta.url)),
      "@sqraft/ai-tools": fileURLToPath(new URL("../../packages/ai-tools/src/index.ts", import.meta.url)),
    },
  },
});
