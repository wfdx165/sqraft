/** 应用元信息只取一次（主进程 IPC）：保存文件、app_info 工具、日志共用同一份。 */
import type { AppInfo } from "../shared/ipc";

let pending: Promise<AppInfo> | null = null;

export function appInfo(): Promise<AppInfo> {
  return (pending ??= window.sqraft.app.info());
}
