/**
 * 接入配置的渲染层 store：欢迎页与配置面板共用同一份 `McpSetupInfo`。
 * 端口写操作也经这里广播，避免两个界面各读各的旧值。
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
   * `force` 给配置面板用：每次打开都重新取一次主进程的最新状态。
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

  /** 端口改动后写回，欢迎页与面板一起更新 */
  set(next: McpSetupInfo): void {
    info.value = next;
  },

  /** 改端口：null = 自动（7331 起、被占顺延）；数字 = 严格使用，占用即报错 */
  async savePort(port: number | null): Promise<McpSetupInfo> {
    const next = await window.sqraft.mcp.setPort(port);
    info.value = next;
    return next;
  },
};
