/**
 * 选中框与缩放手柄的屏幕几何。纯函数，不持有状态。
 */
import { worldQuad, worldRect, worldRotation, type NodeId, type Rect } from "@sqraft/core";
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

export interface ScreenPoint {
  x: number;
  y: number;
}

/** 选中框四角（屏幕坐标，含旋转与拖动预览）。 */
export function selectionQuad(
  vp: Viewport,
  id: NodeId,
  resizePreview: ResizePreview | null,
  drag: MovePreview | null,
): ScreenPoint[] | null {
  if (resizePreview && resizePreview.id === id) {
    // 预览是节点局部坐标：仍然走 worldQuad，才能带上祖先偏移与自身旋转
    const quad = worldQuad(docStore.doc, id, resizePreview);
    return quad?.map((p) => worldToScreen(vp, p.x, p.y)) ?? null;
  }
  const quad = worldQuad(docStore.doc, id);
  if (!quad) return null;
  const dx = drag && drag.mode === "move" && drag.moved ? drag.offsetX : 0;
  const dy = drag && drag.mode === "move" && drag.moved ? drag.offsetY : 0;
  return quad.map((p) => worldToScreen(vp, p.x + dx, p.y + dy));
}

/** 旋转选中框的 8 个手柄位置。 */
export function handlePointsOfQuad(quad: ScreenPoint[]): Array<[ResizeHandle, number, number]> {
  const [a, b, c, d] = quad;
  const mid = (p: ScreenPoint, q: ScreenPoint) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  const n = mid(a, b);
  const e = mid(b, c);
  const s = mid(c, d);
  const w = mid(d, a);
  return [
    ["nw", a.x, a.y],
    ["n", n.x, n.y],
    ["ne", b.x, b.y],
    ["e", e.x, e.y],
    ["se", c.x, c.y],
    ["s", s.x, s.y],
    ["sw", d.x, d.y],
    ["w", w.x, w.y],
  ];
}

/** 当前选中对象在屏幕上的轴对齐包围盒（含移动/缩放预览与旋转）。 */
export function selectionScreenRect(
  vp: Viewport,
  id: NodeId,
  resizePreview: ResizePreview | null,
  drag: MovePreview | null,
): Rect | null {
  const quad = selectionQuad(vp, id, resizePreview, drag);
  if (!quad) {
    const r = worldRect(docStore.doc, id);
    if (!r) return null;
    const a = worldToScreen(vp, r.x, r.y);
    const b = worldToScreen(vp, r.x + r.width, r.y + r.height);
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  }
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** 世界位移 → 节点本地轴位移（用于旋转后的缩放手柄）。 */
export function localDelta(nodeId: NodeId, dx: number, dy: number): { dx: number; dy: number } {
  const angle = (-worldRotation(docStore.doc, nodeId) * Math.PI) / 180;
  if (!angle) return { dx, dy };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { dx: dx * cos - dy * sin, dy: dx * sin + dy * cos };
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
