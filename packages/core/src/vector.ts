/**
 * 矢量路径几何：锚点 / 手柄 → 包围盒、缩放、采样与命中。
 * 全部为纯函数，不依赖 DOM，可在 Node 下测试（architecture.md §3）。
 *
 * 路径由一条或多条轮廓组成（多轮廓是差集带洞的前提，ADR-0040）；
 * `fillRule` 决定多条轮廓围出的区域怎么填充。
 */

import { AppError } from "./errors";
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

/** 一条独立轮廓：带洞形状由多条轮廓 + `evenodd` 表达。 */
export interface VectorContour {
  closed: boolean;
  anchors: VectorAnchor[];
}

export type FillRule = "nonzero" | "evenodd";

export interface VectorPath {
  contours: VectorContour[];
  fillRule: FillRule;
}

/** 曲线采样段数：命中检测与叠加层预览共用，兼顾精度与开销。 */
export const VECTOR_SAMPLES = 16;

export interface NormalizedVector {
  /** 平移后最小坐标为 0 的路径 */
  vector: VectorPath;
  /** 平移前的紧包围盒（曲线范围，不含控制柄；宽高至少为 1） */
  bounds: Rect;
}

export function makeAnchor(x: number, y: number, patch: Partial<VectorAnchor> = {}): VectorAnchor {
  return { x, y, inX: 0, inY: 0, outX: 0, outY: 0, ...patch };
}

/** 单轮廓路径的便捷构造：钢笔、SVG 导入、agent 的 `points` 入口共用。 */
export function pathFromAnchors(
  anchors: readonly VectorAnchor[],
  closed = false,
  fillRule: FillRule = "nonzero",
): VectorPath {
  return { contours: [{ closed, anchors: anchors.map((a) => ({ ...a })) }], fillRule };
}

export function cloneVector(vector: VectorPath): VectorPath {
  return {
    contours: vector.contours.map((c) => ({ closed: c.closed, anchors: c.anchors.map((a) => ({ ...a })) })),
    fillRule: vector.fillRule,
  };
}

/** 只替换第 `index` 条轮廓，其余轮廓原样保留（编辑单条轮廓时用）。 */
export function replaceContour(
  vector: VectorPath,
  index: number,
  contour: VectorContour,
): VectorPath {
  return {
    contours: vector.contours.map((c, i) =>
      i === index ? { closed: contour.closed, anchors: contour.anchors.map((a) => ({ ...a })) } : c,
    ),
    fillRule: vector.fillRule,
  };
}

/** 三次贝塞尔在 [0,1] 上的紧包围盒（含端点与内部极值），不含控制柄。 */
function cubicExtent(p0: number, c1: number, c2: number, p3: number): { min: number; max: number } {
  let min = Math.min(p0, p3);
  let max = Math.max(p0, p3);
  // B'(t) = 0 的根：3(-p0 + 3c1 - 3c2 + p3)t² + 6(p0 - 2c1 + c2)t + 3(c1 - p0)
  const a = -p0 + 3 * c1 - 3 * c2 + p3;
  const b = 2 * (p0 - 2 * c1 + c2);
  const c = c1 - p0;
  const at = (t: number) => {
    const mt = 1 - t;
    return mt * mt * mt * p0 + 3 * mt * mt * t * c1 + 3 * mt * t * t * c2 + t * t * t * p3;
  };
  const consider = (t: number) => {
    if (!(t > 0 && t < 1)) return;
    const v = at(t);
    if (v < min) min = v;
    if (v > max) max = v;
  };
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) consider(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      consider((-b + root) / (2 * a));
      consider((-b - root) / (2 * a));
    }
  }
  return { min, max };
}

/** 曲线（锚点 + 手柄）的紧包围盒：控制柄不算进范围，节点框贴合实际形状。 */
export function vectorBounds(vector: VectorPath): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const track = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const contour of vector.contours) {
    const anchors = contour.anchors;
    if (anchors.length === 0) continue;
    if (anchors.length === 1) {
      track(anchors[0].x, anchors[0].y);
      continue;
    }
    const last = contour.closed ? anchors.length : anchors.length - 1;
    for (let i = 0; i < last; i++) {
      const a = anchors[i];
      const b = anchors[(i + 1) % anchors.length];
      if (!a || !b) continue;
      const x = cubicExtent(a.x, a.x + a.outX, b.x + b.inX, b.x);
      const y = cubicExtent(a.y, a.y + a.outY, b.y + b.inY, b.y);
      track(x.min, y.min);
      track(x.max, y.max);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** 把整条路径（所有轮廓）平移到包围盒左上角为 (0,0)，返回平移后的路径与原包围盒。 */
export function normalizeVector(
  contours: readonly VectorContour[],
  fillRule: FillRule = "nonzero",
): NormalizedVector {
  const bounds = vectorBounds({
    contours: contours.map((c) => ({ closed: c.closed, anchors: [...c.anchors] })),
    fillRule,
  });
  return {
    vector: {
      contours: contours.map((c) => ({
        closed: c.closed,
        anchors: c.anchors.map((a) => ({ ...a, x: a.x - bounds.x, y: a.y - bounds.y })),
      })),
      fillRule,
    },
    bounds,
  };
}

/** 按比例缩放所有轮廓的锚点与手柄（用于节点宽高变化）。 */
export function scaleVector(vector: VectorPath, sx: number, sy: number): VectorPath {
  const kx = Number.isFinite(sx) && sx > 0 ? sx : 1;
  const ky = Number.isFinite(sy) && sy > 0 ? sy : 1;
  return {
    contours: vector.contours.map((c) => ({
      closed: c.closed,
      anchors: c.anchors.map((a) => ({
        x: a.x * kx,
        y: a.y * ky,
        inX: a.inX * kx,
        inY: a.inY * ky,
        outX: a.outX * kx,
        outY: a.outY * ky,
      })),
    })),
    fillRule: vector.fillRule,
  };
}

/** 闭合约束：每条轮廓至少 2 个锚点，闭合至少 3 个。 */
/** 单条路径的轮廓数上限：布尔结果与 SVG 导入远用不满，只挡明显滥用（agent 传超大 contours）。 */
export const VECTOR_MAX_CONTOURS = 256;
/** 全部轮廓的锚点总数上限：展平、命中与渲染都按锚点数走，超大会拖垮画布。 */
export const VECTOR_MAX_TOTAL_ANCHORS = 20000;

export function validateVector(vector: VectorPath): void {
  if (!Array.isArray(vector.contours) || vector.contours.length === 0) {
    throw new Error("路径至少需要一条轮廓");
  }
  if (vector.fillRule !== "nonzero" && vector.fillRule !== "evenodd") {
    throw new Error("填充规则必须是 nonzero 或 evenodd");
  }
  if (vector.contours.length > VECTOR_MAX_CONTOURS) {
    throw new AppError("core.path.tooManyContours", { count: vector.contours.length, limit: VECTOR_MAX_CONTOURS });
  }
  const totalAnchors = vector.contours.reduce((sum, contour) => sum + contour.anchors.length, 0);
  if (totalAnchors > VECTOR_MAX_TOTAL_ANCHORS) {
    throw new AppError("core.path.tooManyAnchors", { count: totalAnchors, limit: VECTOR_MAX_TOTAL_ANCHORS });
  }
  for (const contour of vector.contours) {
    if (!Array.isArray(contour.anchors) || contour.anchors.length < 2) {
      throw new Error("路径至少需要 2 个锚点");
    }
    if (contour.closed && contour.anchors.length < 3) {
      throw new Error("闭合路径至少需要 3 个锚点");
    }
    for (const a of contour.anchors) {
      for (const v of [a.x, a.y, a.inX, a.inY, a.outX, a.outY]) {
        if (!Number.isFinite(v)) throw new Error("路径锚点必须是有限数值");
      }
    }
  }
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * 把一条轮廓采样成折线（首点 + 每段采样点）。
 * 无手柄的段只保留端点；闭合轮廓最后回到首点。
 */
export function flattenContour(contour: VectorContour, samples = VECTOR_SAMPLES): { x: number; y: number }[] {
  const anchors = contour.anchors;
  if (anchors.length === 0) return [];
  const out = [{ x: anchors[0].x, y: anchors[0].y }];
  const segments = contour.closed ? anchors.length : anchors.length - 1;
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

/** 整条路径采样：每条轮廓一组折线。 */
export function flattenVector(vector: VectorPath, samples = VECTOR_SAMPLES): { x: number; y: number }[][] {
  return vector.contours.map((c) => flattenContour(c, samples));
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
  let best = Infinity;
  for (const contour of vector.contours) {
    const pts = flattenContour(contour);
    if (pts.length === 1) {
      best = Math.min(best, Math.hypot(x - pts[0].x, y - pts[0].y));
      continue;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      best = Math.min(best, pointSegmentDistance(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y));
    }
  }
  return best;
}

/**
 * 点是否在形状内部：所有轮廓按 `fillRule` 累加环绕数 / 奇偶。
 * 开放轮廓按填充语义隐式闭合（与 canvas / SVG 的 fill 一致）；只描边的路径由调用方传 `filled=false`。
 */
export function pointInVector(vector: VectorPath, x: number, y: number): boolean {
  let winding = 0;
  let parity = 0;
  let hasContour = false;
  for (const contour of vector.contours) {
    const pts = flattenContour(contour);
    if (pts.length < 3) continue;
    hasContour = true;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) parity ^= 1;
      const side = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
      if (a.y <= y) {
        if (b.y > y && side > 0) winding += 1;
      } else if (b.y <= y && side < 0) {
        winding -= 1;
      }
    }
  }
  if (!hasContour) return false;
  return vector.fillRule === "evenodd" ? parity === 1 : winding !== 0;
}

/** 路径命中：任一轮廓的描边容差内，或填充时的内部区域。 */
export function hitVector(vector: VectorPath, x: number, y: number, tolerance: number, filled: boolean): boolean {
  if (distanceToVector(vector, x, y) <= tolerance) return true;
  return filled && pointInVector(vector, x, y);
}
