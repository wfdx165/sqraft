/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

interface Window {
  /** preload 暴露的唯一入口，类型来自 shared/ipc。 */
  sqraft: import("../shared/ipc").SqraftApi;
}
