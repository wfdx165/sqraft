/**
 * 自绘右键菜单的状态与入口（纯 UI，不进文档）。
 * 画布、左栏、工具栏溢出共用同一个菜单实例。
 */
import { reactive } from "vue";

export interface ContextMenuItem {
  label: string;
  /** 右侧的快捷键/补充说明 */
  hint?: string;
  /** Icon.vue 里的图标名 */
  icon?: string;
  /** 危险动作（删除这类）用警示色 */
  danger?: boolean;
  disabled?: boolean;
  /** 在这一项之前画一条分隔线 */
  separator?: boolean;
  run: () => void;
}

export const contextMenu = reactive({
  open: false,
  x: 0,
  y: 0,
  items: [] as ContextMenuItem[],
});

/** 在屏幕坐标处打开菜单；没有可用的项就直接不开。 */
export function openContextMenu(position: { x: number; y: number }, items: ContextMenuItem[]): void {
  const visible = items.filter(Boolean);
  if (visible.length === 0) return;
  contextMenu.open = true;
  contextMenu.x = Math.round(position.x);
  contextMenu.y = Math.round(position.y);
  contextMenu.items = visible;
}

export function closeContextMenu(): void {
  if (!contextMenu.open) return;
  contextMenu.open = false;
  contextMenu.items = [];
}
