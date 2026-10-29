/**
 * 选中框与缩放手柄的屏幕几何。纯函数，不持有状态。
 */
import { worldRect, type NodeId, type Rect } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { docStore } from "../store";

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface MovePreview {
  mode: string;
  moved: boolean;
  offsetX: number;
  offsetY: number;
}

export interface ResizePreview {
  id: NodeId;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function handlePoints(r: Rect): Array<[ResizeHandle, number, number]> {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const x2 = r.x + r.width;
  const y2 = r.y + r.height;
  return [
    ["nw", r.x, r.y],
    ["n", cx, r.y],
    ["ne", x2, r.y],
    ["e", x2, cy],
    ["se", x2, y2],
    ["s", cx, y2],
    ["sw", r.x, y2],
    ["w", r.x, cy],
  ];
}

/** 当前选中对象在屏幕上的矩形（含移动/缩放预览）。 */
export function selectionScreenRect(
  vp: Viewport,
  id: NodeId,
  resizePreview: ResizePreview | null,
  drag: MovePreview | null,
): Rect | null {
  const r = worldRect(docStore.doc, id);
  if (!r) return null;
  if (resizePreview && resizePreview.id === id) {
    const a = worldToScreen(vp, resizePreview.x, resizePreview.y);
    const b = worldToScreen(vp, resizePreview.x + resizePreview.width, resizePreview.y + resizePreview.height);
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  }
  const dx = drag && drag.mode === "move" && drag.moved ? drag.offsetX : 0;
  const dy = drag && drag.mode === "move" && drag.moved ? drag.offsetY : 0;
  const a = worldToScreen(vp, r.x + dx, r.y + dy);
  const b = worldToScreen(vp, r.x + dx + r.width, r.y + dy + r.height);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

/** 根据手柄与指针位移计算新矩形（世界坐标；`keepAspect` 对应 Shift）。 */
export function resizeRect(
  start: Rect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  keepAspect: boolean,
  min: number,
): Rect {
  let x = start.x;
  let y = start.y;
  let width = start.width;
  let height = start.height;
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  if (handle.includes("e")) width = start.width + dx;
  if (handle.includes("s")) height = start.height + dy;
  if (handle.includes("w")) {
    x = start.x + dx;
    width = start.width - dx;
  }
  if (handle.includes("n")) {
    y = start.y + dy;
    height = start.height - dy;
  }

  const corner = handle.length === 2;
  if (corner && keepAspect) {
    const aspect = start.width / Math.max(1, start.height);
    if (Math.abs(width - start.width) >= Math.abs(height - start.height)) height = width / aspect;
    else width = height * aspect;
    if (handle.includes("w")) x = right - width;
    if (handle.includes("n")) y = bottom - height;
  }

  if (width < min) {
    width = min;
    if (handle.includes("w")) x = right - min;
  }
  if (height < min) {
    height = min;
    if (handle.includes("n")) y = bottom - min;
  }
  return { x, y, width, height };
}
