/**
 * 画布渐变手柄：几何换算、命中、拖动换算与绘制。
 *
 * 几何部分全是纯函数（不碰 DOM），可在 Node 下单测；绘制函数只收一个 2D context。
 * 渐变坐标是"相对节点包围盒的 0–1"；换算直接取 `worldQuad` 的四角做仿射映射——
 * 它已经逐层绕各自中心合成过旋转，祖辈有旋转时也不会错位。
 */
import {
  isGradientPaint,
  isGradientValue,
  worldQuad,
  type DocNode,
  type DocState,
  type GradientStop,
  type GradientValue,
  type NodeId,
  type QuadGeometry,
  type SolidPaint,
  type TokenEntry,
  type WorldPoint,
} from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";

/** 手柄命中半径（屏幕像素），与绘制尺寸一致；重叠时渐变手柄优先。 */
export const GRADIENT_HANDLE_HIT_PX = 6;
/** 点中渐变线的容差（屏幕像素），用于"点线插入色标"。 */
export const GRADIENT_LINE_HIT_PX = 4;

export type GradientHandleKind = "from" | "to" | "stop";

export interface GradientHandle {
  kind: GradientHandleKind;
  /** "stop" 时是色标下标，其余为 -1 */
  index: number;
  /** 世界坐标 */
  x: number;
  y: number;
}

export interface GradientFrame {
  nodeId: NodeId;
  kind: "fill" | "stroke";
  value: GradientValue;
  /** 世界坐标四角（左上、右上、右下、左下），与 `worldQuad` 同序 */
  quad: [WorldPoint, WorldPoint, WorldPoint, WorldPoint];
}

export interface GradientFrameOptions {
  /** 缩放预览用的局部几何（与 `worldQuad` 的 geometry 同义） */
  geometry?: QuadGeometry;
  /** 移动预览的世界坐标平移量 */
  offset?: { x: number; y: number };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

/**
 * 选中节点上要编辑哪个渐变：填充优先，填充不是渐变时看描边。
 * 两者同时是渐变时固定编辑填充（描边的渐变量在检查器里调）。
 */
export function gradientTargetOf(
  node: DocNode,
  tokens: Record<string, TokenEntry>,
): { kind: "fill" | "stroke"; value: GradientValue } | null {
  for (const kind of ["fill", "stroke"] as const) {
    const paint = node.style[kind];
    if (!paint) continue;
    if (isGradientPaint(paint)) return { kind, value: paint };
    if (!paint.token) continue;
    const entry = tokens[paint.token];
    if (entry?.type === "gradient" && isGradientValue(entry.value)) return { kind, value: entry.value };
  }
  return null;
}

/**
 * 组一个可编辑的渐变框；节点没有渐变或取不到几何时返回 null。
 * `options.geometry / offset` 供拖拽中的预览使用（缩放 / 移动时手柄跟着走）。
 */
export function gradientFrameOf(
  state: DocState,
  id: NodeId,
  options: GradientFrameOptions = {},
): GradientFrame | null {
  const node = state.nodes[id];
  if (!node) return null;
  const target = gradientTargetOf(node, state.tokens);
  if (!target) return null;
  const quad = worldQuad(state, id, options.geometry);
  if (!quad || quad.length < 4) return null;
  const dx = options.offset?.x ?? 0;
  const dy = options.offset?.y ?? 0;
  const corners = quad.map((p) => ({ x: p.x + dx, y: p.y + dy })) as GradientFrame["quad"];
  return { nodeId: id, kind: target.kind, value: target.value, quad: corners };
}

/** 0–1 局部坐标 → 世界坐标（沿四角做仿射映射，天然支持旋转祖先）。 */
export function unitToWorld(frame: GradientFrame, x: number, y: number): { x: number; y: number } {
  const [tl, tr, , bl] = frame.quad;
  const ex = tr.x - tl.x;
  const ey = tr.y - tl.y;
  const fx = bl.x - tl.x;
  const fy = bl.y - tl.y;
  return { x: tl.x + ex * x + fx * y, y: tl.y + ey * x + fy * y };
}

/** 世界坐标 → 0–1 局部坐标（unitToWorld 的逆）；退化（零尺寸）时返回 0。 */
export function worldToUnit(frame: GradientFrame, x: number, y: number): { x: number; y: number } {
  const [tl, tr, , bl] = frame.quad;
  const ex = tr.x - tl.x;
  const ey = tr.y - tl.y;
  const fx = bl.x - tl.x;
  const fy = bl.y - tl.y;
  const det = ex * fy - ey * fx;
  if (Math.abs(det) < 1e-9) return { x: 0, y: 0 };
  const px = x - tl.x;
  const py = y - tl.y;
  return { x: (px * fy - py * fx) / det, y: (ex * py - ey * px) / det };
}

/** 色标在渐变线上的位置（0–1）。 */
function pointAt(value: GradientValue, t: number): { x: number; y: number } {
  return {
    x: value.from.x + (value.to.x - value.from.x) * t,
    y: value.from.y + (value.to.y - value.from.y) * t,
  };
}

/** 全部手柄的世界坐标：起点、终点、以及每个色标。 */
export function gradientHandles(frame: GradientFrame): GradientHandle[] {
  const { value } = frame;
  const out: GradientHandle[] = [];
  const from = unitToWorld(frame, value.from.x, value.from.y);
  out.push({ kind: "from", index: -1, ...from });
  const to = unitToWorld(frame, value.to.x, value.to.y);
  out.push({ kind: "to", index: -1, ...to });
  value.stops.forEach((stop, index) => {
    const point = pointAt(value, clamp01(stop.offset));
    out.push({ kind: "stop", index, ...unitToWorld(frame, point.x, point.y) });
  });
  return out;
}

/** 命中手柄：色标优先（它们压在线上），其次端点。 */
export function hitGradientHandle(
  frame: GradientFrame,
  point: { x: number; y: number },
  tolerance: number,
): GradientHandle | null {
  let best: GradientHandle | null = null;
  let bestDistance = tolerance;
  for (const handle of gradientHandles(frame)) {
    const distance = Math.hypot(handle.x - point.x, handle.y - point.y);
    if (distance > tolerance) continue;
    const tie = Math.abs(distance - bestDistance) <= 1e-9;
    // 同距离时色标优先（它压在端点上方，用户想抓的是色标）
    if (best && (distance > bestDistance || (tie && !(handle.kind === "stop" && best.kind !== "stop")))) continue;
    best = handle;
    bestDistance = distance;
  }
  return best;
}

/** 命中渐变线：返回投影参数 t（0–1）；不在容差内返回 null。 */
export function hitGradientLine(
  frame: GradientFrame,
  point: { x: number; y: number },
  tolerance: number,
): number | null {
  const { value } = frame;
  const from = unitToWorld(frame, value.from.x, value.from.y);
  const to = unitToWorld(frame, value.to.x, value.to.y);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-9) return null;
  const t = clamp01(((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq);
  const px = from.x + dx * t;
  const py = from.y + dy * t;
  return Math.hypot(point.x - px, point.y - py) <= tolerance ? t : null;
}

/**
 * 拖动一个手柄后的新渐变值。
 * - `from`：线性渐变整条线平移，其余类型只移动中心；
 * - `to`：端点跟手（径向半径 / 角度方向 / 菱形半宽都由它决定）；
 * - `stop`：把点投影到渐变线上取 t 作为 offset。
 */
export function dragGradientHandle(
  frame: GradientFrame,
  handle: Pick<GradientHandle, "kind" | "index">,
  point: { x: number; y: number },
): GradientValue {
  const { value } = frame;
  const unit = worldToUnit(frame, point.x, point.y);
  if (handle.kind === "to") {
    return { ...value, to: { x: unit.x, y: unit.y } };
  }
  if (handle.kind === "from") {
    if (value.type !== "linear") return { ...value, from: { x: unit.x, y: unit.y } };
    const dx = unit.x - value.from.x;
    const dy = unit.y - value.from.y;
    return {
      ...value,
      from: { x: unit.x, y: unit.y },
      to: { x: value.to.x + dx, y: value.to.y + dy },
    };
  }
  return setStopOffset(frame, handle.index, point);
}

/** 色标拖动：offset = 点到渐变线的投影参数。 */
export function setStopOffset(
  frame: GradientFrame,
  index: number,
  point: { x: number; y: number },
): GradientValue {
  const { value } = frame;
  const unit = worldToUnit(frame, point.x, point.y);
  const dx = value.to.x - value.from.x;
  const dy = value.to.y - value.from.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq > 1e-9 ? clamp01(((unit.x - value.from.x) * dx + (unit.y - value.from.y) * dy) / lengthSq) : 0;
  const stops = value.stops.map((stop, i) => (i === index ? { ...stop, offset: t } : stop));
  return { ...value, stops: stops.sort((a, b) => a.offset - b.offset) };
}

/** 在 t 处插入色标：颜色沿用最近的色标（可能是 Token 引用），不凭空造颜色。 */
export function insertStopAt(value: GradientValue, t: number): { value: GradientValue; index: number } | null {
  if (value.stops.length >= 16) return null;
  const offset = clamp01(t);
  let nearest = value.stops[0];
  let distance = Infinity;
  for (const stop of value.stops) {
    const d = Math.abs(stop.offset - offset);
    if (d < distance) {
      distance = d;
      nearest = stop;
    }
  }
  const added: GradientStop = { offset, color: { ...(nearest?.color ?? { value: "#ffffff" }) } };
  const stops = [...value.stops, added].sort((a, b) => a.offset - b.offset);
  return { value: { ...value, stops }, index: stops.indexOf(added) };
}

/** 删除色标；少于 2 个时返回 null（渐变至少要两个）。 */
export function removeStopAt(value: GradientValue, index: number): GradientValue | null {
  if (value.stops.length <= 2) return null;
  const stops = value.stops.filter((_, i) => i !== index);
  return stops.length === value.stops.length ? null : { ...value, stops };
}

export interface DrawGradientOptions {
  /** 当前正在拖的手柄（高亮） */
  active?: { kind: GradientHandleKind; index: number } | null;
  /** 色标颜色解析（Token → 具体色值），用于给色标圆点上色 */
  colorOf?: (color: SolidPaint) => string;
  accent?: string;
}

/** 在屏幕空间画渐变线、端点与色标（调用方保证 ctx 未变换）。 */
export function drawGradientHandles(
  g: CanvasRenderingContext2D,
  vp: Viewport,
  frame: GradientFrame,
  options: DrawGradientOptions = {},
): void {
  const accent = options.accent ?? "#4f46e5";
  const { value } = frame;
  const fromWorld = unitToWorld(frame, value.from.x, value.from.y);
  const toWorld = unitToWorld(frame, value.to.x, value.to.y);
  const from = worldToScreen(vp, fromWorld.x, fromWorld.y);
  const to = worldToScreen(vp, toWorld.x, toWorld.y);

  g.save();
  g.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  g.lineWidth = 1;
  g.strokeStyle = "rgba(79, 70, 229, 0.55)";
  g.setLineDash([4, 3]);
  g.beginPath();
  g.moveTo(from.x, from.y);
  g.lineTo(to.x, to.y);
  g.stroke();
  g.setLineDash([]);

  // 端点：白色方块 + 强调色描边
  for (const [kind, point] of [
    ["from", from],
    ["to", to],
  ] as const) {
    const active = options.active?.kind === kind;
    g.beginPath();
    g.rect(point.x - 4, point.y - 4, 8, 8);
    g.fillStyle = active ? accent : "#ffffff";
    g.fill();
    g.strokeStyle = accent;
    g.lineWidth = 1.25;
    g.stroke();
  }

  // 色标：圆点，内部填该色标的颜色
  value.stops.forEach((stop, index) => {
    const point = pointAt(value, clamp01(stop.offset));
    const world = unitToWorld(frame, point.x, point.y);
    const screen = worldToScreen(vp, world.x, world.y);
    const active = options.active?.kind === "stop" && options.active.index === index;
    g.beginPath();
    g.arc(screen.x, screen.y, active ? 5.5 : 4.5, 0, Math.PI * 2);
    g.fillStyle = options.colorOf?.(stop.color) ?? "#ffffff";
    g.fill();
    g.lineWidth = active ? 2 : 1.25;
    g.strokeStyle = active ? accent : "#ffffff";
    g.stroke();
    g.beginPath();
    g.arc(screen.x, screen.y, active ? 5.5 : 4.5, 0, Math.PI * 2);
    g.strokeStyle = accent;
    g.lineWidth = 1;
    g.globalAlpha = active ? 0 : 0.55;
    g.stroke();
    g.globalAlpha = 1;
  });
  g.restore();
}
