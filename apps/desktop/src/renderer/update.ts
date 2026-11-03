/**
 * 渲染层的更新状态（纯 UI，不进文档）。
 *
 * 真源在主进程：这里只缓存一份快照给工具栏胶囊、关于面板用。
 * 不做版本比较、不发请求、不碰文件系统。
 */
import { computed, reactive } from "vue";
import type { UpdateState } from "../shared/ipc";
import { showToast } from "./toast";

export const updateUi = reactive<UpdateState>({
  phase: "idle",
  currentVersion: "",
  latestVersion: null,
  notes: null,
  publishedAt: null,
  progress: 0,
  message: null,
  readyAt: null,
  supported: false,
});

function apply(next: UpdateState): void {
  Object.assign(updateUi, next);
}

let dispose: (() => void) | null = null;

/** 挂载时订阅主进程状态；dev 热更新会重跑模块，先摘旧监听再装新的。 */
export function installUpdates(): void {
  dispose?.();
  const off = window.sqraft.update.onState(apply);
  dispose = () => {
    off();
    dispose = null;
  };
  void window.sqraft.update.state().then(apply);
}

/** 就绪：可以重启安装 */
export const updateReady = computed(() => updateUi.phase === "ready");

/** 手动检查：失败原因用 toast 说一次，状态本身留在关于面板里 */
export async function checkForUpdates(manual = true): Promise<void> {
  try {
    const next = await window.sqraft.update.check(manual);
    apply(next);
    if (next.phase === "up-to-date") showToast(`已是最新版本 ${next.currentVersion}`);
    if (next.phase === "error" && next.message) showToast(next.message, "error");
    if (next.phase === "unsupported" || next.phase === "dev") {
      if (next.message) showToast(next.message);
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), "error");
  }
}

/** 重启安装：主进程调 app.quit()，未保存文档由关闭守卫接管 */
export function restartToUpdate(): void {
  void window.sqraft.update.restart();
}

/** 关于面板的一句话状态 */
export function updateStatusText(): string {
  switch (updateUi.phase) {
    case "dev":
      return "开发版本不检查更新";
    case "unsupported":
      return updateUi.message ?? "当前平台暂不支持自动更新";
    case "checking":
      return "正在检查更新…";
    case "downloading":
      return `正在下载 ${Math.round(updateUi.progress * 100)}%`;
    case "ready":
      return `新版本 ${updateUi.latestVersion ?? ""} 已就绪，重启后安装`;
    case "up-to-date":
      return "已是最新版本";
    case "error":
      return updateUi.message ?? "检查更新失败";
    default:
      return updateUi.supported ? "尚未检查更新" : (updateUi.message ?? "当前不可用");
  }
}

import.meta.hot?.dispose(() => dispose?.());
