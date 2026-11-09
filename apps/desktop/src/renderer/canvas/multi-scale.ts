/**
 * 多选缩放：拖选区包围盒的手柄，整组等比缩放。
 *
 * 一次拖拽 = 一条撤销（与裁切拖拽同一套事务做法）；`⇧` 锁定比例。
 * 几何/样式/裁切的换算在 core 的 `node.scale` 里。
 */
import type { Rect } from "@sqraft/core";
import { docStore, ui } from "../store";
import type { ResizeHandle } from "./selection";

export interface MultiScaleState {
  start: Rect;
  handle: ResizeHandle;
  /** 已经应用过的比例：拖动中只下发增量，避免重复叠乘 */
  last: { sx: number; sy: number };
}

let commit: (() => void) | null = null;

export function beginMultiScale(start: Rect, handle: ResizeHandle): MultiScaleState {
  commit = null;
  void docStore.transact(
    "缩放",
    () =>
      new Promise<void>((resolve) => {
        commit = resolve;
      }),
  );
  return { start, handle, last: { sx: 1, sy: 1 } };
}

export function endMultiScale(): void {
  commit?.();
  commit = null;
}

/** 取消（Esc）：回滚到拖拽前，且不留撤销记录。 */
export function abortMultiScale(): void {
  docStore.abortTransact();
  commit = null;
}

export function applyMultiScale(
  state: MultiScaleState,
  world: { x: number; y: number },
  keepAspect: boolean,
): void {
  const handle = state.handle;
  const { x, y, width, height } = state.start;
  let sx = 1;
  let sy = 1;
  if (handle.includes("e")) sx = (world.x - x) / Math.max(1, width);
  else if (handle.includes("w")) sx = (x + width - world.x) / Math.max(1, width);
  if (handle.includes("s")) sy = (world.y - y) / Math.max(1, height);
  else if (handle.includes("n")) sy = (y + height - world.y) / Math.max(1, height);

  // 边手柄只改一个轴：另一个轴跟着走，避免把图形拉扁
  if (handle === "n" || handle === "s") sx = sy;
  if (handle === "e" || handle === "w") sy = sx;
  if (keepAspect) {
    const factor = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
    sx = factor;
    sy = factor;
  }
  sx = clamp(sx);
  sy = clamp(sy);

  const relX = sx / state.last.sx;
  const relY = sy / state.last.sy;
  if (Math.abs(relX - 1) < 1e-4 && Math.abs(relY - 1) < 1e-4) return;

  // 锚点 = 不动的那个角
  const originX = handle.includes("e") ? x : handle.includes("w") ? x + width : x;
  const originY = handle.includes("s") ? y : handle.includes("n") ? y + height : y;
  docStore.apply(
    {
      type: "node.scale",
      params: { nodeIds: [...ui.selection], originX, originY, scaleX: relX, scaleY: relY },
    },
    "缩放",
  );
  state.last = { sx, sy };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(20, Math.max(0.05, value));
}
