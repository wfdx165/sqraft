/**
 * 矢量路径几何：锚点 / 手柄 → 包围盒、缩放、采样与命中。
 * 全部为纯函数，不依赖 DOM，可在 Node 下测试（architecture.md §3）。
 */

import type { Rect } from "./model";

/** 路径锚点：坐标是节点本地坐标，手柄是相对锚点的偏移（0 = 无手柄）。 */
export interface VectorAnchor {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

export interface VectorPath {
  closed: boolean;
  anchors: VectorAnchor[];
}

/** 曲线采样段数：命中检测与叠加层预览共用，兼顾精度与开销。 */
export const VECTOR_SAMPLES = 16;

export interface NormalizedVector {
  /** 平移后最小坐标为 0 的路径 */
  vector: VectorPath;
  /** 平移前锚点 + 手柄的包围盒（宽高至少为 1） */
  bounds: Rect;
}

export function makeAnchor(x: number, y: number, patch: Partial<VectorAnchor> = {}): VectorAnchor {
  return { x, y, inX: 0, inY: 0, outX: 0, outY: 0, ...patch };
}

/** 锚点 + 手柄端点的包围盒；宽高最小为 1，避免零尺寸节点。 */
export function vectorBounds(vector: VectorPath): Rect {
  const anchors = vector.anchors;
  if (anchors.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const a of anchors) {
    for (const [x, y] of [
      [a.x, a.y],
      [a.x + a.inX, a.y + a.inY],
      [a.x + a.outX, a.y + a.outY],
    ]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** 把路径平移到包围盒左上角为 (0,0)，返回平移后的路径与原包围盒。 */
export function normalizeVector(anchors: readonly VectorAnchor[], closed: boolean): NormalizedVector {
  const bounds = vectorBounds({ closed, anchors: [...anchors] });
  return {
    vector: {
      closed,
      anchors: anchors.map((a) => ({ ...a, x: a.x - bounds.x, y: a.y - bounds.y })),
    },
    bounds,
  };
}

/** 按比例缩放锚点与手柄（用于节点宽高变化）。 */
export function scaleVector(vector: VectorPath, sx: number, sy: number): VectorPath {
  const kx = Number.isFinite(sx) && sx > 0 ? sx : 1;
  const ky = Number.isFinite(sy) && sy > 0 ? sy : 1;
  return {
    closed: vector.closed,
    anchors: vector.anchors.map((a) => ({
      x: a.x * kx,
      y: a.y * ky,
      inX: a.inX * kx,
      inY: a.inY * ky,
      outX: a.outX * kx,
      outY: a.outY * ky,
    })),
  };
}

/** 闭合约束：至少 2 个锚点，闭合至少 3 个。 */
export function validateVector(vector: VectorPath): void {
  if (!Array.isArray(vector.anchors) || vector.anchors.length < 2) {
    throw new Error("路径至少需要 2 个锚点");
  }
  if (vector.closed && vector.anchors.length < 3) {
    throw new Error("闭合路径至少需要 3 个锚点");
  }
  for (const a of vector.anchors) {
    for (const v of [a.x, a.y, a.inX, a.inY, a.outX, a.outY]) {
      if (!Number.isFinite(v)) throw new Error("路径锚点必须是有限数值");
    }
  }
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * 把路径采样成折线（首点 + 每段采样点）。
 * 无手柄的段只保留端点；闭合路径最后回到首点。
 */
export function flattenVector(vector: VectorPath, samples = VECTOR_SAMPLES): { x: number; y: number }[] {
  const anchors = vector.anchors;
  if (anchors.length === 0) return [];
  const out = [{ x: anchors[0].x, y: anchors[0].y }];
  const segments = vector.closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    const c1x = a.x + a.outX;
    const c1y = a.y + a.outY;
    const c2x = b.x + b.inX;
    const c2y = b.y + b.inY;
    const curved = a.outX !== 0 || a.outY !== 0 || b.inX !== 0 || b.inY !== 0;
    if (!curved) {
      out.push({ x: b.x, y: b.y });
      continue;
    }
    for (let s = 1; s <= samples; s++) {
      const t = s / samples;
      out.push({ x: cubicAt(a.x, c1x, c2x, b.x, t), y: cubicAt(a.y, c1y, c2y, b.y, t) });
    }
  }
  return out;
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 点到路径实际几何的最短距离（世界/本地坐标，调用方负责换算容差）。 */
export function distanceToVector(vector: VectorPath, x: number, y: number): number {
  const pts = flattenVector(vector);
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    best = Math.min(best, pointSegmentDistance(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y));
  }
  return best;
}

/** 点是否在闭合路径内部（射线法；开放路径请勿调用）。 */
export function pointInVector(vector: VectorPath, x: number, y: number): boolean {
  const pts = flattenVector(vector);
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    const intersects = a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** 路径命中：描边容差内，或闭合且填充时的内部。 */
export function hitVector(vector: VectorPath, x: number, y: number, tolerance: number, filled: boolean): boolean {
  if (distanceToVector(vector, x, y) <= tolerance) return true;
  return filled && vector.closed && pointInVector(vector, x, y);
}
