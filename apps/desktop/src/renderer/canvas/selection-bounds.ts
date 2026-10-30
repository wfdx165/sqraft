/**
 * 选区包围盒与手柄位置：画布与检查器共用一份实现。
 * 包围盒忽略旋转（与 `worldRect` 一致），多选缩放/对齐/检查器 X·Y·W·H 都以它为准。
 */
import { worldRect, type DocState, type NodeId, type Rect } from "@sqraft/core";
import type { ResizeHandle } from "./selection";

export function selectionBounds(doc: DocState, ids: readonly NodeId[]): Rect | null {
  const boxes = ids.map((id) => worldRect(doc, id)).filter((box): box is Rect => Boolean(box));
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 包围盒的 8 个手柄（屏幕坐标）。 */
export function boundsHandlePoints(
  tl: { x: number; y: number },
  br: { x: number; y: number },
): Array<[ResizeHandle, number, number]> {
  const cx = (tl.x + br.x) / 2;
  const cy = (tl.y + br.y) / 2;
  return [
    ["nw", tl.x, tl.y],
    ["n", cx, tl.y],
    ["ne", br.x, tl.y],
    ["e", br.x, cy],
    ["se", br.x, br.y],
    ["s", cx, br.y],
    ["sw", tl.x, br.y],
    ["w", tl.x, cy],
  ];
}
