/**
 * 窗口位置恢复：记住上次的尺寸/位置/最大化，但绝不能把窗口恢复到看不见的地方。
 * 纯函数，显示器信息由调用方传入。
 */
import type { WindowBounds } from "./preferences";

export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_WIDTH = 960;
const MIN_HEIGHT = 600;
const VISIBLE_MARGIN = 80;

function overlaps(a: DisplayRect, b: DisplayRect, margin: number): boolean {
  return (
    a.x + a.width > b.x + margin &&
    b.x + b.width > a.x + margin &&
    a.y + a.height > b.y + margin &&
    b.y + b.height > a.y + margin
  );
}

/** 恢复窗口边界；与所有显示器都几乎没有重叠时丢掉坐标，交给系统居中。 */
export function restoreBounds(saved: WindowBounds | undefined, displays: DisplayRect[]): WindowBounds {
  const width = Math.max(MIN_WIDTH, saved?.width ?? 1440);
  const height = Math.max(MIN_HEIGHT, saved?.height ?? 900);
  const maximized = saved?.maximized ?? false;
  if (!saved || saved.x === undefined || saved.y === undefined) return { width, height, maximized };

  const rect = { x: saved.x, y: saved.y, width, height };
  // 要求横竖都至少露出 VISIBLE_MARGIN，否则窗口会被恢复成"看不见但占着位置"
  const visible = displays.some((display) => overlaps(rect, display, VISIBLE_MARGIN));
  return visible ? { ...rect, maximized } : { width, height, maximized };
}
