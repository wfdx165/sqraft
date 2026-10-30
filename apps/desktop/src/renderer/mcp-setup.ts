/**
 * 接入配置的渲染层 store：欢迎页与配置面板共用同一份 `McpSetupInfo`。
 *
 * 之前两个组件各自 `ref` 一份，于是在面板里装完 CLI、关掉面板，欢迎页仍显示
 * "安装命令行工具"（那份 info 还是挂载时读到的旧值）。写操作一律经 `set` 广播。
 */
import { ref } from "vue";
import type { McpSetupInfo } from "../shared/ipc";

const info = ref<McpSetupInfo | null>(null);
/** 并发调用共享同一个请求，避免两个组件同时挂载时打两次 IPC */
let pending: Promise<McpSetupInfo | null> | null = null;

export const mcpSetup = {
  /** 只读引用；模板里直接用，脚本里用 `.value` */
  info,

  /**
   * 读一次配置。失败返回 null（调用方决定怎么提示），且不清空已经拿到的值。
   * `force` 给配置面板用：每次打开都重新核对磁盘上的软链状态。
   */
  ensure(force = false): Promise<McpSetupInfo | null> {
    if (!force && info.value) return Promise.resolve(info.value);
    if (pending) return pending;
    pending = window.sqraft.mcp
      .setup()
      .then((next) => {
        info.value = next;
        return next;
      })
      .catch(() => null)
      .finally(() => {
        pending = null;
      });
    return pending;
  },

  /** 安装等写操作拿到新配置后写回，欢迎页与面板一起更新 */
  set(next: McpSetupInfo): void {
    info.value = next;
  },
};
