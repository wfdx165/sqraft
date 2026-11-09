/**
 * 导出 PNG 的入口：文件菜单 / ⌘⇧E 落到这里（命名规则在 export-name.ts）。
 */
import { exportUi } from "./store";

/** 文件菜单 / ⌘⇧E：导出“当前选择或活动页”（画布侧解析目标）。 */
export function openExportDefault(): void {
  exportUi.open = true;
}
