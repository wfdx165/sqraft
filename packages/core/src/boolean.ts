/**
 * 布尔运算的几何内核：轮廓 → 折线 → 多边形求交 → 曲线回拟合。
 *
 * 纯函数、不依赖 DOM（不变式 3）；命令层负责操作数解释、样式与图层位置（见任务 04）。
 * 坐标与输入完全一致（调用方给父容器坐标，结果也是父容器坐标），不做节点平移。
 *
 * 流程（ADR-0040）：
 * 1. 三次贝塞尔按 0.25px 容差自适应展平成折线；
 * 2. `polygon-clipping` 求并 / 差 / 交 / 对称差；
 * 3. 结果环按 ≈15° 尖角切开，其余用 Schneider 算法回拟合为三次贝塞尔。
 */

// `polygon-clipping` 的 ESM 产物只有 default 导出（CJS 才有具名导出），
// 类型声明却写成具名；这里用命名空间 + default 回退，两种产物都能跑。
import * as clipping from "polygon-clipping";
import type { MultiPolygon, Polygon, Ring } from "polygon-clipping";
import { AppError } from "./errors";
import type { Rect } from "./model";
import type { VectorAnchor, VectorContour } from "./vector";
import { vectorBounds } from "./vector";

const clip = (clipping as unknown as { default?: typeof clipping }).default ?? clipping;
const { union, difference, intersection, xor } = clip;

export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";

/** 展平容差（文档单位）：与 `docs/specs/boolean-ops.md` 一致。 */
export const BOOLEAN_FLATTEN_TOLERANCE = 0.25;
/** 尖角判定（度）：转角超过它就在该点切开，不再拟合成光滑曲线。 */
export const BOOLEAN_CORNER_ANGLE = 15;
/** 单个操作数展平后的段数上限，超出拒绝并提示简化。 */
export const BOOLEAN_MAX_SEGMENTS = 2000;
/** 全部操作数展平后的段数总和上限：polygon-clipping 的开销随总量增长。 */
export const BOOLEAN_MAX_TOTAL_SEGMENTS = 10000;

export interface BooleanGeometryOptions {
  tolerance?: number;
  maxSegments?: number;
  totalMaxSegments?: number;
}

type Pt = { x: number; y: number };
type Cubic = { p0: Pt; c1: Pt; c2: Pt; p3: Pt };

function invalid(): never {
  throw new AppError("core.boolean.invalidGeometry");
}

function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function unit(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return { x: 1, y: 0 };
  return { x: dx / len, y: dy / len };
}

function negate(v: Pt): Pt {
  return { x: -v.x, y: -v.y };
}

function pointLineDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return distance(p, a);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/* ---------- 展平 ---------- */

function flattenCubicIntoSegments(p0: Pt, c1: Pt, c2: Pt, p3: Pt, tolerance: number, out: Pt[], depth = 0): void {
  const flat = Math.max(pointLineDistance(c1, p0, p3), pointLineDistance(c2, p0, p3));
  if (flat <= tolerance || depth >= 16) {
    out.push(p3);
    return;
  }
  // de Casteljau 在 t=0.5 切分
  const ab = { x: (p0.x + c1.x) / 2, y: (p0.y + c1.y) / 2 };
  const bc = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 };
  const cd = { x: (c2.x + p3.x) / 2, y: (c2.y + p3.y) / 2 };
  const abbc = { x: (ab.x + bc.x) / 2, y: (ab.y + bc.y) / 2 };
  const bccd = { x: (bc.x + cd.x) / 2, y: (bc.y + cd.y) / 2 };
  const mid = { x: (abbc.x + bccd.x) / 2, y: (abbc.y + bccd.y) / 2 };
  flattenCubicIntoSegments(p0, ab, abbc, mid, tolerance, out, depth + 1);
  flattenCubicIntoSegments(mid, bccd, cd, p3, tolerance, out, depth + 1);
}

/** 一条轮廓 → 闭合折线（首尾同一个点）。开放轮廓拒绝：布尔只取填充区域。 */
function flattenContourToRing(contour: VectorContour, tolerance: number): Ring {
  if (!contour.closed) throw new AppError("core.boolean.openContour");
  const anchors = contour.anchors;
  if (anchors.length < 3) invalid();
  const points: Pt[] = [{ x: anchors[0].x, y: anchors[0].y }];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    const curved = a.outX !== 0 || a.outY !== 0 || b.inX !== 0 || b.inY !== 0;
    if (!curved) {
      points.push({ x: b.x, y: b.y });
      continue;
    }
    flattenCubicIntoSegments(
      { x: a.x, y: a.y },
      { x: a.x + a.outX, y: a.y + a.outY },
      { x: b.x + b.inX, y: b.y + b.inY },
      { x: b.x, y: b.y },
      tolerance,
      points,
    );
  }
  // 闭合：去掉尾部的重复点，最后补回首点
  const ring: Ring = [];
  for (const p of points) {
    const last = ring[ring.length - 1];
    if (last && Math.abs(last[0] - p.x) < 1e-9 && Math.abs(last[1] - p.y) < 1e-9) continue;
    ring.push([p.x, p.y]);
  }
  if (ring.length < 3) invalid();
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Math.abs(first[0] - last[0]) > 1e-9 || Math.abs(first[1] - last[1]) > 1e-9) ring.push([first[0], first[1]]);
  if (ring.length < 4) invalid();
  return ring;
}

/* ---------- 轮廓集合 → 带洞多边形 ---------- */

function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function ringBounds(ring: Ring): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function boundsInside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - 1e-9 &&
    inner.y >= outer.y - 1e-9 &&
    inner.x + inner.width <= outer.x + outer.width + 1e-9 &&
    inner.y + inner.height <= outer.y + outer.height + 1e-9
  );
}

function pointInRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[j];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/**
 * 把一个操作数的多条轮廓组装成带洞多边形：按面积从大到小、用包含关系定父子，
 * 偶数层是外环、奇数层是洞（等价于 evenodd 的嵌套语义）。
 */
function contoursToPolygons(rings: Ring[]): MultiPolygon {
  const infos = rings.map((ring) => ({
    ring,
    area: Math.abs(ringArea(ring)),
    bbox: ringBounds(ring),
    parent: -1 as number,
  }));
  const order = infos.map((_, i) => i).sort((a, b) => infos[b].area - infos[a].area);
  const polygons: Polygon[] = [];
  const polygonOf = new Map<number, Polygon>();
  for (const index of order) {
    const info = infos[index];
    let parent = -1;
    for (const candidate of order) {
      if (candidate === index) continue;
      const outer = infos[candidate];
      if (outer.area <= info.area) continue;
      if (!boundsInside(info.bbox, outer.bbox)) continue;
      if (!pointInRing(outer.ring, info.ring[0][0], info.ring[0][1])) continue;
      if (parent === -1 || infos[parent].area > outer.area) parent = candidate;
    }
    info.parent = parent;
    const depth = parent === -1 ? 0 : 1 + depthOf(infos, parent);
    if (depth % 2 === 0) {
      const polygon: Polygon = [info.ring];
      polygons.push(polygon);
      polygonOf.set(index, polygon);
    } else {
      // 洞属于最近的外环祖先（中间可能隔着「洞中岛」）
      let owner = parent;
      while (owner !== -1 && depthOf(infos, owner) % 2 === 1) owner = infos[owner].parent;
      const polygon = owner === -1 ? undefined : polygonOf.get(owner);
      if (!polygon) invalid();
      polygon.push(info.ring);
    }
  }
  if (polygons.length === 0) invalid();
  return polygons;
}

function depthOf(infos: Array<{ parent: number }>, index: number): number {
  let depth = 0;
  let cur = infos[index].parent;
  while (cur !== -1) {
    depth += 1;
    cur = infos[cur].parent;
  }
  return depth;
}

/* ---------- 曲线回拟合（Schneider） ---------- */

function chordParams(points: Pt[]): number[] {
  const u: number[] = [0];
  for (let i = 1; i < points.length; i++) u.push(u[i - 1] + distance(points[i - 1], points[i]));
  const total = u[u.length - 1];
  if (total < 1e-12) return points.map((_, i) => i / Math.max(1, points.length - 1));
  return u.map((value) => value / total);
}

function bezierAt(c: Cubic, t: number): Pt {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const d = 3 * mt * t * t;
  const e = t * t * t;
  return {
    x: a * c.p0.x + b * c.c1.x + d * c.c2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.c1.y + d * c.c2.y + e * c.p3.y,
  };
}

/** 固定两端切线的三次贝塞尔最小二乘拟合（Schneider 的 generateBezier）。 */
function generateBezier(points: Pt[], u: number[], tHat1: Pt, tHat2: Pt): Cubic {
  const p0 = points[0];
  const p3 = points[points.length - 1];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < points.length; i++) {
    const t = u[i];
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * t;
    const b2 = 3 * mt * t * t;
    const b3 = t * t * t;
    const a1 = { x: tHat1.x * b1, y: tHat1.y * b1 };
    const a2 = { x: tHat2.x * b2, y: tHat2.y * b2 };
    c00 += a1.x * a1.x + a1.y * a1.y;
    c01 += a1.x * a2.x + a1.y * a2.y;
    c11 += a2.x * a2.x + a2.y * a2.y;
    const tmp = {
      x: points[i].x - (p0.x * (b0 + b1) + p3.x * (b2 + b3)),
      y: points[i].y - (p0.y * (b0 + b1) + p3.y * (b2 + b3)),
    };
    x0 += a1.x * tmp.x + a1.y * tmp.y;
    x1 += a2.x * tmp.x + a2.y * tmp.y;
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let alpha2 = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const chord = distance(p0, p3);
  const epsilon = 1e-6 * Math.max(1, chord);
  if (!Number.isFinite(alpha1) || alpha1 < epsilon || alpha1 > chord * 2) alpha1 = chord / 3;
  if (!Number.isFinite(alpha2) || alpha2 < epsilon || alpha2 > chord * 2) alpha2 = chord / 3;
  return {
    p0,
    c1: { x: p0.x + tHat1.x * alpha1, y: p0.y + tHat1.y * alpha1 },
    c2: { x: p3.x + tHat2.x * alpha2, y: p3.y + tHat2.y * alpha2 },
    p3,
  };
}

function maxFitError(points: Pt[], u: number[], curve: Cubic): { error: number; index: number } {
  let error = 0;
  let index = 0;
  for (let i = 0; i < points.length; i++) {
    const at = bezierAt(curve, u[i]);
    const d = distance(at, points[i]);
    if (d > error) {
      error = d;
      index = i;
    }
  }
  return { error, index };
}

function lineCubic(p0: Pt, p3: Pt): Cubic {
  return { p0, c1: { x: p0.x, y: p0.y }, c2: { x: p3.x, y: p3.y }, p3 };
}

function fitCubic(points: Pt[], tHat1: Pt, tHat2: Pt, tolerance: number, out: Cubic[], depth = 0): void {
  const last = points.length - 1;
  if (points.length === 2) {
    out.push(lineCubic(points[0], points[1]));
    return;
  }
  if (depth >= 12) {
    out.push(lineCubic(points[0], points[last]));
    return;
  }
  const chord = distance(points[0], points[last]);
  if (chord < 1e-9) {
    out.push(lineCubic(points[0], points[last]));
    return;
  }
  let maxDistance = 0;
  for (let i = 1; i < last; i++) maxDistance = Math.max(maxDistance, pointLineDistance(points[i], points[0], points[last]));
  if (maxDistance <= tolerance) {
    out.push(lineCubic(points[0], points[last]));
    return;
  }
  const u = chordParams(points);
  const curve = generateBezier(points, u, tHat1, tHat2);
  const { error, index } = maxFitError(points, u, curve);
  if (error <= tolerance) {
    out.push(curve);
    return;
  }
  const split = Math.max(1, Math.min(last - 1, index));
  const center = unit(points[split + 1], points[split - 1]);
  fitCubic(points.slice(0, split + 1), tHat1, center, tolerance, out, depth + 1);
  fitCubic(points.slice(split), negate(center), tHat2, tolerance, out, depth + 1);
}

/**
 * 顶点处的转角（弧度）：入向（前一点 → 本点）与出向（本点 → 下一点）的夹角。
 * 直线是 0、直角是 90°；不能用「本点指向两侧」的夹角（那在直线上等于 180°）。
 */
function turnAt(points: Pt[], i: number): number {
  const n = points.length;
  const prev = points[(i - 1 + n) % n];
  const next = points[(i + 1) % n];
  if (!prev || !next) return 0;
  const incoming = unit(prev, points[i]);
  const outgoing = unit(points[i], next);
  const dot = Math.max(-1, Math.min(1, incoming.x * outgoing.x + incoming.y * outgoing.y));
  return Math.acos(dot);
}

/** 按转弯角切分：超过阈值的顶点是尖角，左右分别拟合。闭合环把起点也当尖角。 */
function cornerIndices(points: Pt[]): number[] {
  const maxTurn = (BOOLEAN_CORNER_ANGLE * Math.PI) / 180;
  const corners = [0];
  for (let i = 1; i < points.length; i++) {
    if (turnAt(points, i) > maxTurn) corners.push(i);
  }
  // 全光滑的闭合环（如正圆）至少切两段，避免首尾同点拟合出零长度段
  if (corners.length < 2) corners.push(Math.max(1, Math.floor(points.length / 2)));
  return corners;
}

/** 闭合环 → 锚点。环首尾同一个点；先从转角最大的顶点起，避免接缝落在曲线中间。 */
function refitRing(ring: Ring, tolerance: number): VectorAnchor[] {
  const points = ring.map(([x, y]) => ({ x, y }));
  // polygon-clipping 的环首尾相同；容错一下，没闭合也能处理
  if (points.length > 1 && distance(points[0], points[points.length - 1]) < 1e-9) points.pop();
  pullDuplicatePoints(points);
  if (points.length < 3) invalid();
  let start = 0;
  let bestTurn = -1;
  for (let i = 0; i < points.length; i++) {
    const turn = turnAt(points, i);
    if (turn > bestTurn) {
      bestTurn = turn;
      start = i;
    }
  }
  const rotated = [...points.slice(start), ...points.slice(0, start)];
  const n = rotated.length;
  const extended = [...rotated, ...rotated, rotated[0]];
  const corners = cornerIndices(rotated);
  const segments: Cubic[] = [];
  for (let k = 0; k < corners.length; k++) {
    const from = corners[k];
    let to = corners[(k + 1) % corners.length];
    if (to <= from) to += n;
    const run = extended.slice(from, to + 1);
    if (run.length < 2) continue;
    const first = run[0];
    const last = run[run.length - 1];
    fitCubic(run, unit(first, run[1]), unit(last, run[run.length - 2]), tolerance, segments);
  }
  if (segments.length === 0) invalid();
  return segmentsToAnchors(segments);
}

function pullDuplicatePoints(points: Pt[]): void {
  for (let i = points.length - 1; i > 0; i--) {
    if (distance(points[i], points[i - 1]) < 1e-9) points.splice(i, 1);
  }
}

function segmentsToAnchors(segments: Cubic[]): VectorAnchor[] {
  const anchors: VectorAnchor[] = [];
  for (const segment of segments) {
    anchors.push({
      x: segment.p0.x,
      y: segment.p0.y,
      inX: 0,
      inY: 0,
      outX: segment.c1.x - segment.p0.x,
      outY: segment.c1.y - segment.p0.y,
    });
  }
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const end = i === segments.length - 1 ? anchors[0] : anchors[i + 1];
    end.inX = segment.c2.x - segment.p3.x;
    end.inY = segment.c2.y - segment.p3.y;
  }
  return anchors;
}

/* ---------- 入口 ---------- */

function runBoolean(op: BooleanOp, geoms: MultiPolygon[]): MultiPolygon {
  const [first, ...rest] = geoms;
  switch (op) {
    case "union":
      return union(first, ...rest);
    case "subtract":
      return difference(first, ...rest);
    case "intersect":
      return intersection(first, ...rest);
    case "exclude":
      return xor(first, ...rest);
  }
}

/**
 * 对一组操作数做布尔运算，返回可直接写成 `path` 的多轮廓（`fillRule: evenodd`）。
 *
 * - 每个操作数是若干条**闭合**轮廓；多轮廓按包含关系组装成带洞形状；
 * - `subtract` 的第一个操作数是被减数（命令层负责按图层顺序排好）；
 * - 失败抛 `AppError`：`core.boolean.openContour` / `tooComplex` / `noOverlap` / `emptyResult` / `invalidGeometry`。
 */
export function booleanContours(
  operands: readonly (readonly VectorContour[])[],
  op: BooleanOp,
  options: BooleanGeometryOptions = {},
): VectorContour[] {
  if (operands.length < 2) throw new AppError("core.boolean.single");
  const tolerance = options.tolerance ?? BOOLEAN_FLATTEN_TOLERANCE;
  const maxSegments = options.maxSegments ?? BOOLEAN_MAX_SEGMENTS;
  const totalMaxSegments = options.totalMaxSegments ?? BOOLEAN_MAX_TOTAL_SEGMENTS;

  const geoms: MultiPolygon[] = [];
  let totalSegments = 0;
  for (const contours of operands) {
    if (contours.length === 0) invalid();
    const rings: Ring[] = [];
    let segments = 0;
    for (const contour of contours) {
      if (!contour.closed) throw new AppError("core.boolean.openContour");
      const ring = flattenContourToRing(contour, tolerance);
      // 零面积（共线 / 退化）直接拒绝，别让它悄悄参与求交
      if (Math.abs(ringArea(ring)) < 1e-9) invalid();
      segments += ring.length - 1;
      rings.push(ring);
    }
    if (segments > maxSegments) throw new AppError("core.boolean.tooComplex");
    totalSegments += segments;
    if (totalSegments > totalMaxSegments) throw new AppError("core.boolean.tooComplex");
    geoms.push(contoursToPolygons(rings));
  }

  let result: MultiPolygon;
  try {
    result = runBoolean(op, geoms);
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid();
  }
  if (!result || result.length === 0) {
    if (op === "intersect") throw new AppError("core.boolean.noOverlap");
    // subtract 被完全覆盖是合法输入、空结果是确定结论，别归入"几何退化"
    if (op === "subtract") throw new AppError("core.boolean.emptyResult");
    invalid();
  }

  const contours: VectorContour[] = [];
  for (const polygon of result) {
    for (const ring of polygon) {
      const anchors = refitRing(ring, tolerance);
      contours.push({ closed: true, anchors });
    }
  }
  if (contours.length === 0) invalid();
  return contours;
}

/** 结果包围盒（曲线范围，不含控制柄），命令层用来推导节点框。 */
export function booleanBounds(contours: readonly VectorContour[]): Rect {
  return vectorBounds({ contours: contours.map((c) => ({ closed: c.closed, anchors: [...c.anchors] })), fillRule: "evenodd" });
}
