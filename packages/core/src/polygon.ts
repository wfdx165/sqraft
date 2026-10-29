/**
 * 参数化多边形几何：边数 + 包围盒 → 顶点、命中与边数夹紧。
 * 纯函数，不依赖 DOM（architecture.md §3、ADR-0013）。
 */

/** 边数下限：3 = 三角形。 */
export const MIN_POLYGON_SIDES = 3;
/** 边数上限：12 边以上在小尺寸下已无视觉收益。 */
export const MAX_POLYGON_SIDES = 12;

export interface Point {
  x: number;
  y: number;
}

/** 边数归一化：取整并夹到 3–12；非法值回落为 3。 */
export function clampSides(sides: number | undefined): number {
  const n = Number.isFinite(sides) ? Math.round(sides as number) : MIN_POLYGON_SIDES;
  return Math.max(MIN_POLYGON_SIDES, Math.min(MAX_POLYGON_SIDES, n));
}

/**
 * 顶点按「包围盒即外接矩形」推导：
 * 先算顶点朝上的正多边形单位坐标，再把 X/Y 各向拉伸到撑满包围盒。
 * 因此只改宽高时顶点自动跟随，且节点框始终等于可见形状的外接矩形。
 */
export function polygonPoints(sides: number | undefined, width: number, height: number): Point[] {
  const n = clampSides(sides);
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const raw: Point[] = [];
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / n;
    raw.push({ x: Math.cos(angle), y: Math.sin(angle) });
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of raw) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  return raw.map((p) => ({ x: ((p.x - minX) / spanX) * w, y: ((p.y - minY) / spanY) * h }));
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

/** 点到多边形边界的最近距离（本地坐标，容差由调用方换算）。 */
export function distanceToPolygon(points: readonly Point[], x: number, y: number): number {
  if (points.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    best = Math.min(best, pointSegmentDistance(x, y, a.x, a.y, b.x, b.y));
  }
  return best;
}

/** 点是否在多边形内部（射线法）。 */
export function pointInPolygon(points: readonly Point[], x: number, y: number): boolean {
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const intersects = a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** 多边形命中：描边容差内，或有填充时的内部。 */
export function hitPolygon(
  points: readonly Point[],
  x: number,
  y: number,
  tolerance: number,
  filled: boolean,
): boolean {
  if (distanceToPolygon(points, x, y) <= tolerance) return true;
  return filled && pointInPolygon(points, x, y);
}
