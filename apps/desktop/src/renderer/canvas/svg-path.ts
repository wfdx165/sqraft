/**
 * SVG path 的 d 解析（纯函数，不依赖 DOM）：支持 M/L/H/V/C/S/Q/T/A/Z，
 * 相对坐标与简写；Q/T 转三次贝塞尔，A 拆成 ≤90° 的贝塞尔段。
 *
 * 返回值按子路径分组：模型一条 `VectorPath` 只能表达一条轮廓，
 * 调用方据此决定是拆成多个 path 节点还是整元素栅格化（有填充的多子路径）。
 */
import { makeAnchor, type VectorAnchor } from "@sqraft/core";

type Cubic = { x: number; y: number; c1?: { x: number; y: number }; c2?: { x: number; y: number } };

/** 一条子路径：`closed` 对应这一段自己的 `Z`。 */
export interface ParsedSubpath {
  closed: boolean;
  anchors: VectorAnchor[];
}

/** 把 SVG path 的 d 解析成一条或多条子路径；空输入返回 null。 */
export function parsePathData(d: string): ParsedSubpath[] | null {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g);
  if (!tokens) return null;
  const subpaths: ParsedSubpath[] = [];
  let anchors: VectorAnchor[] = [];
  let closed = false;
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let lastCubic: { x: number; y: number } | null = null;
  let lastQuad: { x: number; y: number } | null = null;
  let index = 0;

  const finish = (): void => {
    if (anchors.length === 0) return;
    // 收起闭合边：末点与起点重合时去掉重复锚点，把末点的入手柄并到起点上
    if (closed && anchors.length > 1) {
      const first = anchors[0]!;
      const last = anchors[anchors.length - 1]!;
      if (Math.abs(last.x - first.x) < 1e-6 && Math.abs(last.y - first.y) < 1e-6) {
        first.inX = last.inX;
        first.inY = last.inY;
        anchors.pop();
      }
    }
    subpaths.push({ closed, anchors });
    anchors = [];
    closed = false;
  };

  const number = (): number => Number(tokens[index++] ?? 0);
  const previousCubic = (): { x: number; y: number } | null => lastCubic;
  const previousQuad = (): { x: number; y: number } | null => lastQuad;
  const ensureStart = (): void => {
    // Z 之后继续绘制时，新子路径从闭合点开始
    if (anchors.length === 0) anchors.push(makeAnchor(current.x, current.y));
  };
  const push = (): void => {
    anchors.push(makeAnchor(current.x, current.y));
  };
  const lineTo = (x: number, y: number): void => {
    ensureStart();
    current = { x, y };
    push();
    lastCubic = null;
    lastQuad = null;
  };
  const cubicTo = (c1: { x: number; y: number }, c2: { x: number; y: number }, x: number, y: number): void => {
    ensureStart();
    const from = anchors[anchors.length - 1];
    if (from) {
      from.outX = c1.x - from.x;
      from.outY = c1.y - from.y;
    }
    const anchor = makeAnchor(x, y, { inX: c2.x - x, inY: c2.y - y });
    anchors.push(anchor);
    current = { x, y };
    lastCubic = c2;
    lastQuad = null;
  };

  while (index < tokens.length) {
    const command = tokens[index++]!;
    switch (command) {
      case "M":
      case "m": {
        const rel = command === "m";
        const x = number() + (rel ? current.x : 0);
        const y = number() + (rel ? current.y : 0);
        finish();
        anchors = [makeAnchor(x, y)];
        current = { x, y };
        start = { x, y };
        // 后续隐式 lineto
        while (index < tokens.length && !/[A-Za-z]/.test(tokens[index]!)) {
          lineTo(number() + (rel ? current.x : 0), number() + (rel ? current.y : 0));
        }
        break;
      }
      case "L":
      case "l": {
        const rel = command === "l";
        do {
          lineTo(number() + (rel ? current.x : 0), number() + (rel ? current.y : 0));
        } while (index < tokens.length && !/[A-Za-z]/.test(tokens[index]!));
        break;
      }
      case "H":
      case "h": {
        const rel = command === "h";
        do {
          lineTo(number() + (rel ? current.x : 0), current.y);
        } while (index < tokens.length && !/[A-Za-z]/.test(tokens[index]!));
        break;
      }
      case "V":
      case "v": {
        const rel = command === "v";
        do {
          lineTo(current.x, number() + (rel ? current.y : 0));
        } while (index < tokens.length && !/[A-Za-z]/.test(tokens[index]!));
        break;
      }
      case "C":
      case "c": {
        const rel = command === "c";
        do {
          const c1 = { x: number() + (rel ? current.x : 0), y: number() + (rel ? current.y : 0) };
          const c2 = { x: number() + (rel ? current.x : 0), y: number() + (rel ? current.y : 0) };
          const x = number() + (rel ? current.x : 0);
          const y = number() + (rel ? current.y : 0);
          cubicTo(c1, c2, x, y);
        } while (index < tokens.length && !/[A-Za-z]/.test(tokens[index]!));
        break;
      }
      case "S":
      case "s": {
        const rel = command === "s";
        do {
          const previous = previousCubic();
          const first = previous ? { x: 2 * current.x - previous.x, y: 2 * current.y - previous.y } : { ...current };
          const c2 = { x: number() + (rel ? current.x : 0), y: number() + (rel ? current.y : 0) };
          const x = number() + (rel ? current.x : 0);
          const y = number() + (rel ? current.y : 0);
          cubicTo(first, c2, x, y);
        } while (index < tokens.length && !/[A-Za-z]/.test(tokens[index]!));
        break;
      }
      case "Q":
      case "q": {
        const rel = command === "q";
        do {
          const q = { x: number() + (rel ? current.x : 0), y: number() + (rel ? current.y : 0) };
          const x = number() + (rel ? current.x : 0);
          const y = number() + (rel ? current.y : 0);
          const c1 = { x: current.x + (2 / 3) * (q.x - current.x), y: current.y + (2 / 3) * (q.y - current.y) };
          const c2 = { x: x + (2 / 3) * (q.x - x), y: y + (2 / 3) * (q.y - y) };
          cubicTo(c1, c2, x, y);
          lastQuad = q;
        } while (index < tokens.length && !/[A-Za-z]/.test(tokens[index]!));
        break;
      }
      case "T":
      case "t": {
        const rel = command === "t";
        do {
          const previous = previousQuad();
          const q = previous ? { x: 2 * current.x - previous.x, y: 2 * current.y - previous.y } : { ...current };
          const x = number() + (rel ? current.x : 0);
          const y = number() + (rel ? current.y : 0);
          const c1 = { x: current.x + (2 / 3) * (q.x - current.x), y: current.y + (2 / 3) * (q.y - current.y) };
          const c2 = { x: x + (2 / 3) * (q.x - x), y: y + (2 / 3) * (q.y - y) };
          cubicTo(c1, c2, x, y);
          lastQuad = q;
        } while (index < tokens.length && !/[A-Za-z]/.test(tokens[index]!));
        break;
      }
      case "A":
      case "a": {
        const rel = command === "a";
        do {
          const rx = Math.abs(number());
          const ry = Math.abs(number());
          const rotation = number();
          const largeArc = number() !== 0;
          const sweep = number() !== 0;
          const x = number() + (rel ? current.x : 0);
          const y = number() + (rel ? current.y : 0);
          for (const cubic of arcToCubics(current.x, current.y, rx, ry, rotation, largeArc, sweep, x, y)) {
            if (cubic.c1 && cubic.c2) cubicTo(cubic.c1, cubic.c2, cubic.x, cubic.y);
            else lineTo(cubic.x, cubic.y);
          }
        } while (index < tokens.length && !/[A-Za-z]/.test(tokens[index]!));
        break;
      }
      case "Z":
      case "z":
        closed = true;
        finish();
        current = { ...start };
        lastCubic = null;
        lastQuad = null;
        break;
      default:
        break;
    }
  }

  finish();
  return subpaths.length ? subpaths : null;
}

/** 端点式圆弧 → 若干三次贝塞尔（每段 ≤ 90°）。 */
function arcToCubics(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotation: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Cubic[] {
  if (rx === 0 || ry === 0) return [{ x: x2, y: y2 }];
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const lambda = (x1p * x1p) / rx2 + (y1p * y1p) / ry2;
  const k = lambda > 1 ? Math.sqrt(lambda) : 1;
  const rxr = rx * k;
  const ryr = ry * k;
  const sign = largeArc === sweep ? -1 : 1;
  const numerator = rxr * rxr * ryr * ryr - rxr * rxr * y1p * y1p - ryr * ryr * x1p * x1p;
  const denominator = rxr * rxr * y1p * y1p + ryr * ryr * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, numerator / (denominator || 1)));
  const cxp = (coef * rxr * y1p) / ryr;
  const cyp = (-coef * ryr * x1p) / rxr;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1))));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const theta = angle(1, 0, (x1p - cxp) / rxr, (y1p - cyp) / ryr);
  let delta = angle((x1p - cxp) / rxr, (y1p - cyp) / ryr, (-x1p - cxp) / rxr, (-y1p - cyp) / ryr);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  const out: Cubic[] = [];
  let t = theta;
  for (let i = 0; i < segments; i += 1) {
    const t2 = t + step;
    const alpha = (4 / 3) * Math.tan(step / 4);
    const p1 = { x: Math.cos(t), y: Math.sin(t) };
    const p2 = { x: Math.cos(t2), y: Math.sin(t2) };
    const toWorld = (p: { x: number; y: number }): { x: number; y: number } => ({
      x: cx + rxr * p.x * cos - ryr * p.y * sin,
      y: cy + rxr * p.x * sin + ryr * p.y * cos,
    });
    const start = toWorld({ x: p1.x - alpha * p1.y, y: p1.y + alpha * p1.x });
    const end = toWorld({ x: p2.x + alpha * p2.y, y: p2.y - alpha * p2.x });
    out.push({ x: toWorld(p2).x, y: toWorld(p2).y, c1: start, c2: end });
    t = t2;
  }
  return out;
}
