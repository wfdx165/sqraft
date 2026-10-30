/**
 * 旋转拖拽：一次拖拽 = 一条撤销；`⇧` 吸附 15°。
 * 角度换算与位置更新在 core 的 `node.rotate` 里。
 */
import { docStore, ui } from "../store";

const SNAP_DEG = 15;

export interface RotateState {
  center: { x: number; y: number };
  /** 按下时的极角（弧度） */
  start: number;
  /** 已经应用过的累计角度（度） */
  applied: number;
}

let commit: (() => void) | null = null;

export function beginRotate(center: { x: number; y: number }, world: { x: number; y: number }): RotateState {
  commit = null;
  void docStore.transact(
    "旋转",
    () =>
      new Promise<void>((resolve) => {
        commit = resolve;
      }),
  );
  return { center, start: Math.atan2(world.y - center.y, world.x - center.x), applied: 0 };
}

export function endRotate(): void {
  commit?.();
  commit = null;
}

/** 取消（Esc）：回滚到拖拽前，且不留撤销记录。 */
export function abortRotate(): void {
  docStore.abortTransact();
  commit = null;
}

export function applyRotate(state: RotateState, world: { x: number; y: number }, snap: boolean): void {
  const current = Math.atan2(world.y - state.center.y, world.x - state.center.x);
  let degrees = ((current - state.start) * 180) / Math.PI;
  if (snap) degrees = Math.round(degrees / SNAP_DEG) * SNAP_DEG;
  const delta = degrees - state.applied;
  if (Math.abs(delta) < 0.01) return;
  docStore.apply(
    {
      type: "node.rotate",
      params: {
        nodeIds: [...ui.selection],
        centerX: state.center.x,
        centerY: state.center.y,
        angle: delta,
      },
    },
    "旋转",
  );
  state.applied = degrees;
}
