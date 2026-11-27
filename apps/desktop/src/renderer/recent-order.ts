/**
 * 最近文件的展示顺序：按**文件修改时间**倒序，不按「最近打开」。
 *
 * 打开一个文件时主进程仍会把它在持久化列表里置顶（原生「打开最近」菜单沿用这个语义），
 * 但欢迎页重新排序：点来点去不会让卡片位置跳动，只有保存或外部修改后才前移。
 * 文件已被移动 / 删除（`mtimeMs` 为 null）的排最后，且保持它们之间的原有顺序。
 */

import type { RecentEntry } from "../shared/ipc";

export function sortRecent(entries: readonly RecentEntry[]): RecentEntry[] {
  return [...entries].sort((a, b) => (b.mtimeMs ?? -1) - (a.mtimeMs ?? -1));
}
