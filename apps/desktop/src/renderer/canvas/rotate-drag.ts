/**
 * 旋转拖拽：一次拖拽 = 一条撤销；`⇧` 吸附 15°。
 * 角度换算与位置更新在 core 的 `node.rotate` 里。
 */
import { docStore, ui } from "../store";

const SNAP_DEG = 15;

/** 四角外侧旋转热区的厚度（规格：角外 12px） */
export const ROTATE_ZONE_PX = 12;

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

/**
 * 旋转热区命中：四角各自的“外侧象限”里、离角点 Chebyshev 距离落在 `(inner, inner + band]` 的点。
 * `inner` 由调用方传缩放手柄的命中半径，保证手柄本体仍是缩放、两个热区不重叠；
 * 纯屏幕几何，`corners` 由调用方按选中框四边形（含节点旋转）给出。
 */
export function rotateZoneAt(
  corners: readonly { x: number; y: number }[],
  sx: number,
  sy: number,
  inner: number,
  band = ROTATE_ZONE_PX,
): boolean {
  if (corners.length === 0 || band <= 0) return false;
  // 以四边形中心判定每个角的“外侧”方向（旋转后的四边形同样适用）
  const centerX = corners.reduce((sum, point) => sum + point.x, 0) / corners.length;
  const centerY = corners.reduce((sum, point) => sum + point.y, 0) / corners.length;
  for (const corner of corners) {
    const dx = sx - corner.x;
    const dy = sy - corner.y;
    const distance = Math.max(Math.abs(dx), Math.abs(dy));
    if (distance <= inner || distance > inner + band) continue;
    // 只吃角的外侧：框内靠近角的地方留给拖动
    if (dx * Math.sign(corner.x - centerX) < 0) continue;
    if (dy * Math.sign(corner.y - centerY) < 0) continue;
    return true;
  }
  return false;
}
