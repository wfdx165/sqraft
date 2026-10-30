/**
 * 导出 PNG 的入口：右键菜单、文件菜单、⌘⇧E 都落到这里（命名规则在 export-name.ts）。
 */
import type { NodeId } from "@sqraft/core";
import { exportUi } from "./store";
import { fileState } from "./file-session";
import { pngFileName } from "./export-name";

/**
 * 打开导出对话框：`nodeIds` 有值时导出这些子树（透明底），否则导出整页（带背景）。
 * 名字只是系统保存框的建议值，用户可以改。
 */
export function openExportFor(target: { pageId: NodeId; nodeIds?: NodeId[]; name: string }): void {
  exportUi.target = { pageId: target.pageId, nodeIds: target.nodeIds };
  exportUi.suggestedName = pngFileName(fileState.name, target.name);
  exportUi.open = true;
}

/** 文件菜单 / ⌘⇧E：回到"当前选择或活动页"的默认目标。 */
export function openExportDefault(): void {
  exportUi.target = null;
  exportUi.suggestedName = "";
  exportUi.open = true;
}
