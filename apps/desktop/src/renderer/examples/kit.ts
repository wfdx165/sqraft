/**
 * 示例文档的构造工具：只做「创建节点 + 挂到父级」，不碰全局状态。
 * 所有尺寸/颜色写死，示例不依赖 Token（ADR-0024）。
 */
import {
  createNode,
  normalizeVector,
  type DocNode,
  type DocState,
  type Effect,
  type GradientType,
  type LayoutSpec,
  type NodeStyle,
  type Paint,
} from "@sqraft/core";
import { parsePathData } from "../canvas/svg-path";

/** 填充：字面量色值或渐变（示例里都写死，不依赖 Token）。 */
export type PaintInput = string | Paint;

function paintOf(fill: PaintInput | undefined): Paint | null | undefined {
  if (fill === undefined) return undefined;
  return typeof fill === "string" ? { value: fill } : fill;
}

/** 渐变色标：`[offset, color]`，offset 0–1。 */
export type StopInput = readonly [number, string];

function gradient(
  type: GradientType,
  from: { x: number; y: number },
  to: { x: number; y: number },
  stops: readonly StopInput[],
): Paint {
  return {
    type,
    from,
    to,
    stops: stops.map(([offset, color]) => ({ offset, color: { value: color } })),
  };
}

/** 线性渐变：`from` / `to` 是相对包围盒的 0–1 坐标。 */
export function linear(
  from: { x: number; y: number },
  to: { x: number; y: number },
  stops: readonly StopInput[],
): Paint {
  return gradient("linear", from, to, stops);
}

/** 径向渐变：`from` 为中心、`to` 决定半径。 */
export function radial(
  from: { x: number; y: number },
  to: { x: number; y: number },
  stops: readonly StopInput[],
): Paint {
  return gradient("radial", from, to, stops);
}

export interface FrameOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: PaintInput;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  layout?: LayoutSpec;
  clip?: boolean;
  effects?: Effect[];
}

export interface TextOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontWeight?: number;
  fill?: PaintInput;
  /** 受控字体栈；不传用渲染层默认 */
  fontFamily?: string;
  align?: "left" | "center" | "right";
  /** 字距（px）；标题类文案常用 */
  letterSpacing?: number;
  /** 行高占字号的百分比（102 = 1.02 倍）；不传用默认 1.4 */
  lineHeightPercent?: number;
}

export function page(doc: DocState, name: string, height = 900, fill = "#f6f7fb"): DocNode {
  const node = createNode("page", {
    name,
    width: 1440,
    height,
    style: { fill: { value: fill } },
  });
  doc.rootIds.push(node.id);
  doc.nodes[node.id] = node;
  return node;
}

export function put(doc: DocState, parent: DocNode, node: DocNode): DocNode {
  node.parentId = parent.id;
  parent.children.push(node.id);
  doc.nodes[node.id] = node;
  return node;
}

export function frame(name: string, options: FrameOptions): DocNode {
  return createNode("frame", {
    name,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
    clip: options.clip ?? true,
    layout: options.layout,
    style: {
      fill: paintOf(options.fill) ?? null,
      stroke: options.stroke ? { value: options.stroke } : undefined,
      strokeWidth: options.stroke ? (options.strokeWidth ?? 1) : undefined,
      effects: options.effects,
      cornerRadius: options.radius
        ? {
            topLeft: options.radius,
            topRight: options.radius,
            bottomRight: options.radius,
            bottomLeft: options.radius,
          }
        : undefined,
    },
  });
}

export function text(name: string, content: string, options: TextOptions): DocNode {
  const style: NodeStyle = {
    fill: paintOf(options.fill ?? "#111827") ?? null,
    fontSize: options.fontSize,
    fontWeight: options.fontWeight ?? 400,
    ...(options.fontFamily ? { fontFamily: options.fontFamily } : {}),
    textAlign: options.align ?? "left",
    ...(options.letterSpacing !== undefined
      ? { letterSpacing: options.letterSpacing, letterSpacingUnit: "px" as const }
      : {}),
    ...(options.lineHeightPercent !== undefined
      ? { lineHeight: options.lineHeightPercent, lineHeightUnit: "percent" as const }
      : {}),
  };
  return createNode("text", {
    name,
    text: content,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
    textAutoResize: "auto-height",
    style,
  });
}

export interface EllipseOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: PaintInput;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  effects?: Effect[];
}

export function ellipse(name: string, options: EllipseOptions): DocNode {
  return createNode("ellipse", {
    name,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
    opacity: options.opacity ?? 1,
    style: {
      fill: paintOf(options.fill) ?? null,
      stroke: options.stroke ? { value: options.stroke } : undefined,
      strokeWidth: options.stroke ? (options.strokeWidth ?? 1) : undefined,
      effects: options.effects,
    },
  });
}

export interface PathOptions {
  fill?: PaintInput;
  stroke?: string;
  strokeWidth?: number;
}

/**
 * 从 SVG 的 `d` 建一条路径（示例里直接用设计稿的原始路径）。
 * 只收单轮廓：多子路径的填充语义与模型不一致，调用方应自己拆开。
 */
export function pathFromD(name: string, d: string, options: PathOptions = {}): DocNode {
  const subpaths = parsePathData(d);
  if (!subpaths || subpaths.length !== 1) throw new Error(`示例路径 "${name}" 必须是单轮廓`);
  const first = subpaths[0]!;
  const { vector, bounds } = normalizeVector(first.anchors, first.closed);
  return createNode("path", {
    name,
    x: bounds.x,
    y: bounds.y,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
    vector,
    style: {
      fill: paintOf(options.fill) ?? null,
      stroke: options.stroke ? { value: options.stroke } : undefined,
      strokeWidth: options.stroke ? (options.strokeWidth ?? 1) : undefined,
    },
  });
}

/** 无偏移的暖/冷光晕：靠投影的软边把颜色晕开。 */
export function glow(color: string, blur: number, spread = 0): Effect {
  return { type: "drop-shadow", visible: true, x: 0, y: 0, blur, spread, color: { value: color } };
}

/** 带偏移的投影（按钮的落影）。 */
export function shadow(x: number, y: number, blur: number, color: string, spread = 0): Effect {
  return { type: "drop-shadow", visible: true, x, y, blur, spread, color: { value: color } };
}

/** 图层模糊：自身边缘糊开，近似径向渐变的柔光。 */
export function softBlur(radius: number): Effect {
  return { type: "layer-blur", visible: true, radius };
}

export function vertical(gap: number, padding: number): LayoutSpec {
  return {
    direction: "vertical",
    gap,
    padding: { top: padding, right: padding, bottom: padding, left: padding },
    mainAlign: "start",
    crossAlign: "start",
    wrap: false,
    crossGap: gap,
    alignContent: "start",
  };
}

export function row(gap: number, wrap = false): LayoutSpec {
  return {
    direction: "horizontal",
    gap,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    mainAlign: "start",
    crossAlign: "start",
    wrap,
    crossGap: gap,
    alignContent: "start",
  };
}
