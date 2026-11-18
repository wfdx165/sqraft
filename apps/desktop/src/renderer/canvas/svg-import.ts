/**
 * SVG 导入（R12）：把外部 SVG 解析成 Sqraft 节点。
 *
 * 只处理「能映射」的子集：形状、路径、文本、分组、use、纯色与线性/径向渐变；
 * 样式按 presentation attributes 继承（fill / stroke / stroke-width / font-*）。
 * 无法映射的元素（filter/mask/pattern、userSpaceOnUse 渐变、多子路径填充等）
 * 逐元素栅格化成图片贴回原位；整份无法解析时才由调用方降级为一张图片。
 * 解析坐标统一换算到当前页面坐标系。
 */
import {
  createNode,
  isGradientPaint,
  makeAnchor,
  vectorBounds,
  type DocNode,
  type GradientStop,
  type NodeStyle,
  type Paint,
  type VectorAnchor,
  type VectorPath,
} from "@sqraft/core";
import { putAsset } from "../assets";
import { parsePathData } from "./svg-path";
import { fontFamilies } from "../fonts";
import { sanitizeSvgStyleText, sanitizeSvgSubtree } from "./svg-sanitize";

/** 2×3 仿射矩阵：[a b c d e f]，与 SVG matrix() 同序。 */
type Mat = [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
const SVG_NS = "http://www.w3.org/2000/svg";

export interface SvgImportResult {
  width: number;
  height: number;
  nodes: DocNode[];
  warnings: string[];
  /** 被逐元素栅格化的元素名 */
  rasterized: string[];
  missingFonts: string[];
}

export type SvgImportOutcome = { status: "ok"; result: SvgImportResult } | { status: "fallback"; reason: string };

function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyPoint(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** 平均缩放（描边宽度、文本尺寸用）。 */
function scaleOf(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

function parseNumberList(value: string | null): number[] {
  if (!value) return [];
  return (value.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
}

function parseTransform(value: string | null): Mat {
  if (!value) return IDENTITY;
  let out: Mat = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  for (let match = re.exec(value); match; match = re.exec(value)) {
    const name = match[1];
    const args = parseNumberList(match[2]);
    let next: Mat = IDENTITY;
    if (name === "matrix" && args.length >= 6) {
      next = [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
    } else if (name === "translate") {
      next = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
    } else if (name === "scale") {
      next = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
    } else if (name === "rotate") {
      const rad = ((args[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const cx = args[1] ?? 0;
      const cy = args[2] ?? 0;
      next = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
    } else if (name === "skewX") {
      next = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    } else if (name === "skewY") {
      next = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    out = multiply(out, next);
  }
  return out;
}

function styleMap(element: Element): Map<string, string> {
  const map = new Map<string, string>();
  const style = element.getAttribute("style");
  if (style) {
    for (const part of style.split(";")) {
      const at = part.indexOf(":");
      if (at > 0) map.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
  }
  return map;
}

function attr(element: Element, styles: Map<string, string>, name: string): string | null {
  return styles.get(name) ?? element.getAttribute(name);
}

/** 用 canvas 把任意 CSS 颜色归一成可存的字符串（命名色、rgb() 都吃）。 */
let colorCtx: CanvasRenderingContext2D | null = null;
function normalizeColor(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none" || trimmed === "transparent") return null;
  colorCtx ??= document.createElement("canvas").getContext("2d");
  if (!colorCtx) return trimmed;
  colorCtx.fillStyle = "#000000";
  colorCtx.fillStyle = trimmed;
  return String(colorCtx.fillStyle);
}

function solid(value: string | null): Paint | null {
  const color = normalizeColor(value);
  return color ? { value: color } : null;
}

function opacityOf(value: string | null): number {
  const parsed = value === null ? 1 : Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
}

/* ---------- 解析上下文 ---------- */

interface ParseContext {
  doc: Document;
  root: Element;
  /** viewBox 的起点与尺寸；节点坐标 = 根用户坐标 − 起点 */
  viewBox: { x: number; y: number; width: number; height: number };
  warnings: string[];
  rasterized: string[];
  missingFonts: Set<string>;
  knownFonts: Set<string>;
  depth: number;
  nodes: DocNode[];
}

const MAX_DEPTH = 32;
const MAX_NODES = 3000;

/** CSS 通用字族：任何系统都有，不算"缺字体"。 */
const GENERIC_FAMILIES = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "cursive",
  "fantasy",
]);

/** 读取渐变：返回 objectBoundingBox 坐标的 Paint；不支持时返回 "fallback"。 */
function gradientOf(ctx: ParseContext, href: string): Paint | "fallback" | null {
  const id = href.replace(/^url\(#?|\)$/g, "").trim();
  if (!id) return null;
  const node = ctx.doc.getElementById(id);
  if (!node || (node.tagName !== "linearGradient" && node.tagName !== "radialGradient")) return "fallback";
  if (node.getAttribute("gradientUnits") === "userSpaceOnUse") return "fallback";
  const stops: GradientStop[] = [];
  for (const stop of Array.from(node.querySelectorAll("stop"))) {
    const offset = stop.getAttribute("offset") ?? "0";
    const offsetValue = offset.trim().endsWith("%") ? Number.parseFloat(offset) / 100 : Number.parseFloat(offset);
    const style = styleMap(stop);
    const color = normalizeColor(attr(stop, style, "stop-color") ?? "black");
    if (!color) continue;
    stops.push({ offset: Math.min(1, Math.max(0, offsetValue || 0)), color: { value: color } });
  }
  if (stops.length < 2) return "fallback";
  const coord = (name: string, fallback: number): number => {
    const raw = node.getAttribute(name);
    if (!raw) return fallback;
    const value = raw.trim().endsWith("%") ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  if (node.tagName === "linearGradient") {
    return {
      type: "linear",
      from: { x: coord("x1", 0), y: coord("y1", 0) },
      to: { x: coord("x2", 1), y: coord("y2", 0) },
      stops,
    };
  }
  return {
    type: "radial",
    from: { x: coord("cx", 0.5), y: coord("cy", 0.5) },
    to: { x: coord("cx", 0.5) + coord("r", 0.5), y: coord("cy", 0.5) },
    ...(node.hasAttribute("fx") || node.hasAttribute("fy")
      ? { focus: { x: coord("fx", 0.5), y: coord("fy", 0.5) } }
      : {}),
    stops,
  };
}

/** 沿父子链继承的样式快照；`null` 表示显式 none。 */
interface InheritedStyle {
  fill?: Paint | null;
  stroke?: Paint | null;
  strokeWidth?: number;
  fillOpacity?: number;
  strokeOpacity?: number;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: NodeStyle["fontStyle"];
  textAlign?: NodeStyle["textAlign"];
}

function paintFromValue(ctx: ParseContext, raw: string, color: string | undefined): Paint | null {
  if (raw === "none") return null;
  if (raw.startsWith("url(")) {
    const paint = gradientOf(ctx, raw);
    if (paint === "fallback") throw new Error("unsupported gradient");
    return paint;
  }
  if (raw === "currentColor") return solid(color ?? "#000000");
  return solid(raw);
}

function firstFamily(value: string): string {
  return value.replace(/["']/g, "").split(",")[0]?.trim() || "sans-serif";
}

function transformOf(element: Element): Mat {
  return parseTransform(element.getAttribute("transform"));
}

/** 元素自身的属性覆盖到继承快照上；缺省字段沿用父级。 */
function mergeInherited(
  ctx: ParseContext,
  element: Element,
  styles: Map<string, string>,
  matrix: Mat,
  parent: InheritedStyle,
): InheritedStyle {
  const next: InheritedStyle = { ...parent };
  const fill = attr(element, styles, "fill");
  if (fill !== null && fill !== "inherit") next.fill = paintFromValue(ctx, fill, next.color);
  const stroke = attr(element, styles, "stroke");
  if (stroke !== null && stroke !== "inherit") next.stroke = paintFromValue(ctx, stroke, next.color);
  const strokeWidth = attr(element, styles, "stroke-width");
  if (strokeWidth !== null) {
    const width = Number(strokeWidth);
    if (Number.isFinite(width) && width >= 0) next.strokeWidth = width * scaleOf(matrix);
  }
  const fillOpacity = attr(element, styles, "fill-opacity");
  if (fillOpacity !== null) next.fillOpacity = opacityOf(fillOpacity);
  const strokeOpacity = attr(element, styles, "stroke-opacity");
  if (strokeOpacity !== null) next.strokeOpacity = opacityOf(strokeOpacity);
  const color = attr(element, styles, "color");
  if (color !== null) next.color = normalizeColor(color) ?? next.color;
  const family = attr(element, styles, "font-family");
  if (family !== null) next.fontFamily = firstFamily(family);
  const size = attr(element, styles, "font-size");
  if (size !== null) {
    const value = Number.parseFloat(size);
    if (Number.isFinite(value) && value > 0) next.fontSize = value * scaleOf(matrix);
  }
  const weight = attr(element, styles, "font-weight");
  if (weight !== null) {
    const value = Number.parseInt(weight, 10);
    if (Number.isFinite(value)) next.fontWeight = value;
  }
  const fontStyle = attr(element, styles, "font-style");
  if (fontStyle !== null) next.fontStyle = fontStyle === "italic" ? "italic" : "normal";
  const anchor = attr(element, styles, "text-anchor");
  if (anchor !== null) {
    next.textAlign = anchor === "middle" ? "center" : anchor === "end" ? "right" : "left";
  }
  return next;
}

/** 继承下来的 Paint 可能被多个节点共用：落进节点前先复制，避免共享引用。 */
function clonePaint(paint: Paint): Paint {
  if (!isGradientPaint(paint)) return { ...paint };
  return {
    ...paint,
    from: { ...paint.from },
    to: { ...paint.to },
    ...(paint.focus ? { focus: { ...paint.focus } } : {}),
    stops: paint.stops.map((stop) => ({ ...stop, color: { ...stop.color } })),
  };
}

/** 合并后的样式快照 → 节点的 NodeStyle（opacity 不在这里，按元素单独处理）。 */
function baseStyle(inherited: InheritedStyle): NodeStyle {
  const style: NodeStyle = {};
  if (inherited.fill !== undefined && inherited.fill !== null) style.fill = clonePaint(inherited.fill);
  if (inherited.stroke !== undefined && inherited.stroke !== null) style.stroke = clonePaint(inherited.stroke);
  const strokeWidth = inherited.strokeWidth;
  if (strokeWidth !== undefined && strokeWidth > 0) style.strokeWidth = strokeWidth;
  const fillOpacity = inherited.fillOpacity ?? 1;
  if (fillOpacity !== 1 && style.fill && !isGradientPaint(style.fill) && style.fill.value) {
    style.fill = { value: withAlpha(style.fill.value, fillOpacity) };
  }
  const strokeOpacity = inherited.strokeOpacity ?? 1;
  if (strokeOpacity !== 1 && style.stroke && !isGradientPaint(style.stroke) && style.stroke.value) {
    style.stroke = { value: withAlpha(style.stroke.value, strokeOpacity) };
  }
  return style;
}

/** 只有平移（无旋转/缩放/斜切）时才能保留 rect / ellipse 节点。 */
function isAxisAligned(m: Mat): boolean {
  return Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6;
}

function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color;
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    return `rgba(${Number.parseInt(color.slice(1, 3), 16)}, ${Number.parseInt(color.slice(3, 5), 16)}, ${Number.parseInt(color.slice(5, 7), 16)}, ${alpha})`;
  }
  return color;
}

function unsupported(element: Element, styles: Map<string, string>): string | null {
  const tag = element.tagName.toLowerCase();
  if (["filter", "mask", "pattern"].some((name) => attr(element, styles, name))) return `${tag} filter/mask/pattern`;
  if (attr(element, styles, "clip-path") && tag !== "svg") return `${tag} clip-path`;
  if (tag === "foreignobject" || tag === "symbol" || tag === "marker") return tag;
  return null;
}

/* ---------- 节点转换 ---------- */

function matrixPath(path: VectorPath, matrix: Mat): VectorPath {
  return {
    closed: path.closed,
    anchors: path.anchors.map((anchor) => {
      const point = applyPoint(matrix, anchor.x, anchor.y);
      const out = applyPoint(matrix, anchor.x + anchor.outX, anchor.y + anchor.outY);
      const into = applyPoint(matrix, anchor.x + anchor.inX, anchor.y + anchor.inY);
      return {
        x: point.x,
        y: point.y,
        outX: out.x - point.x,
        outY: out.y - point.y,
        inX: into.x - point.x,
        inY: into.y - point.y,
      };
    }),
  };
}

function pushPathNode(
  ctx: ParseContext,
  element: Element,
  styles: Map<string, string>,
  matrix: Mat,
  vector: VectorPath,
  fallbackName: string,
  inherited: InheritedStyle,
): void {
  const transformed = matrixPath(vector, matrix);
  const bounds = vectorBounds(transformed);
  const anchors = transformed.anchors.map((anchor) => ({
    ...anchor,
    x: anchor.x - bounds.x,
    y: anchor.y - bounds.y,
  }));
  const style = baseStyle(inherited);
  ctx.nodes.push(
    createNode("path", {
      name: element.getAttribute("id") || fallbackName,
      x: bounds.x,
      y: bounds.y,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
      opacity: opacityOf(attr(element, styles, "opacity")),
      vector: { closed: vector.closed, anchors },
      style,
    }),
  );
}

function rectVector(element: Element): VectorPath {
  const x = Number(element.getAttribute("x") ?? 0);
  const y = Number(element.getAttribute("y") ?? 0);
  const w = Number(element.getAttribute("width") ?? 0);
  const h = Number(element.getAttribute("height") ?? 0);
  return {
    closed: true,
    anchors: [makeAnchor(x, y), makeAnchor(x + w, y), makeAnchor(x + w, y + h), makeAnchor(x, y + h)],
  };
}

function ellipseVector(element: Element, circle: boolean): VectorPath {
  const cx = Number(element.getAttribute("cx") ?? 0);
  const cy = Number(element.getAttribute("cy") ?? 0);
  const rx = circle ? Number(element.getAttribute("r") ?? 0) : Number(element.getAttribute("rx") ?? 0);
  const ry = circle ? rx : Number(element.getAttribute("ry") ?? 0);
  const k = 0.5522847498;
  const anchors: VectorAnchor[] = [
    makeAnchor(cx - rx, cy, { outX: 0, outY: -k * ry, inX: 0, inY: k * ry }),
    makeAnchor(cx, cy - ry, { outX: k * rx, outY: 0, inX: -k * rx, inY: 0 }),
    makeAnchor(cx + rx, cy, { outX: 0, outY: k * ry, inX: 0, inY: -k * ry }),
    makeAnchor(cx, cy + ry, { outX: -k * rx, outY: 0, inX: k * rx, inY: 0 }),
  ];
  return { closed: true, anchors };
}

function pointsVector(element: Element, closed: boolean): VectorPath | null {
  const numbers = parseNumberList(element.getAttribute("points"));
  if (numbers.length < 4) return null;
  const anchors: VectorAnchor[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    anchors.push(makeAnchor(numbers[i]!, numbers[i + 1]!));
  }
  return { closed, anchors };
}

function textOf(
  ctx: ParseContext,
  element: Element,
  styles: Map<string, string>,
  matrix: Mat,
  inherited: InheritedStyle,
): boolean {
  // 复杂文本（tspan 手动定位、textPath、竖排）或旋转/缩放：交给逐元素栅格化
  if (element.querySelector("textPath, tspan[x], tspan[y], tspan[dy]")) return false;
  if (!isAxisAligned(matrix)) return false;
  const content = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!content) return true;
  const style = baseStyle(inherited);
  const size = inherited.fontSize ?? 16;
  const fontFamily = inherited.fontFamily ?? "sans-serif";
  if (!GENERIC_FAMILIES.has(fontFamily.toLowerCase()) && !ctx.knownFonts.has(fontFamily.toLowerCase())) {
    ctx.missingFonts.add(fontFamily);
  }
  const x = Number(element.getAttribute("x") ?? 0);
  const y = Number(element.getAttribute("y") ?? 0);
  const point = applyPoint(matrix, x, y);
  const textStyle: NodeStyle = {
    ...style,
    fontSize: size,
    fontFamily,
    fontWeight: inherited.fontWeight ?? 400,
    ...(inherited.fontStyle ? { fontStyle: inherited.fontStyle } : {}),
    textAlign: inherited.textAlign ?? "left",
  };
  ctx.nodes.push(
    createNode("text", {
      name: element.getAttribute("id") || content.slice(0, 12),
      x: point.x,
      y: point.y - size,
      width: Math.max(24, content.length * size * 0.6),
      height: Math.max(size * 1.4, 1),
      text: content,
      textAutoResize: "auto-width",
      opacity: opacityOf(attr(element, styles, "opacity")),
      style: textStyle,
    }),
  );
  return true;
}

async function imageNode(
  ctx: ParseContext,
  element: Element,
  styles: Map<string, string>,
  matrix: Mat,
): Promise<boolean> {
  // 旋转/缩放的图片交给栅格化，避免把变换丢掉
  if (!isAxisAligned(matrix)) return false;
  const href = element.getAttribute("href") ?? element.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  const x = Number(element.getAttribute("x") ?? 0);
  const y = Number(element.getAttribute("y") ?? 0);
  const width = Number(element.getAttribute("width") ?? 0);
  const height = Number(element.getAttribute("height") ?? 0);
  if (!href || !href.startsWith("data:") || width <= 0 || height <= 0) return false;
  const comma = href.indexOf(",");
  if (comma < 0) return false;
  const header = href.slice(5, comma);
  const payload = href.slice(comma + 1);
  const bytes = header.includes("base64")
    ? Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));
  const asset = await putAsset(bytes);
  if (!asset.ok) return false;
  const point = applyPoint(matrix, x, y);
  ctx.nodes.push(
    createNode("image", {
      name: "image",
      x: point.x,
      y: point.y,
      width: width * scaleOf(matrix),
      height: height * scaleOf(matrix),
      opacity: opacityOf(attr(element, styles, "opacity")),
      image: {
        assetId: asset.id,
        naturalWidth: asset.width,
        naturalHeight: asset.height,
        crop: { x: 0, y: 0, width: asset.width, height: asset.height },
      },
    }),
  );
  return true;
}

/** 不直接可见的定义类标签：跳过即可，被引用的内容由使用方按 id 查找。 */
const NON_RENDERING = new Set([
  "defs",
  "style",
  "title",
  "desc",
  "metadata",
  "lineargradient",
  "radialgradient",
  "filter",
  "clippath",
  "mask",
  "pattern",
  "symbol",
  "marker",
]);

/** 解析一个元素（含递归）。返回 false 表示无法映射，调用方决定逐元素栅格化。 */
async function parseNode(
  ctx: ParseContext,
  element: Element,
  parentMatrix: Mat,
  inherited: InheritedStyle,
): Promise<boolean> {
  if (ctx.depth > MAX_DEPTH || ctx.nodes.length > MAX_NODES) return false;
  const tag = element.tagName.toLowerCase();
  if (NON_RENDERING.has(tag)) return true;
  const styles = styleMap(element);
  if (unsupported(element, styles)) return false;
  const matrix = multiply(parentMatrix, transformOf(element));
  // 元素自身的 fill/stroke/font-* 覆盖继承值，其余沿用父级
  const merged = mergeInherited(ctx, element, styles, matrix, inherited);

  switch (tag) {
    case "svg":
    case "g": {
      const opacity = opacityOf(attr(element, styles, "opacity"));
      const before = ctx.nodes.length;
      ctx.depth += 1;
      for (const child of Array.from(element.children)) {
        if (!(await parseElement(ctx, child, matrix, merged))) {
          ctx.depth -= 1;
          // 子树里已经有节点落进结果：整组回退，交给栅格化，避免重复
          ctx.nodes.length = before;
          return false;
        }
      }
      ctx.depth -= 1;
      if (opacity < 1) {
        for (let i = before; i < ctx.nodes.length; i += 1) {
          const node = ctx.nodes[i]!;
          node.opacity = (node.opacity ?? 1) * opacity;
        }
      }
      return true;
    }
    case "rect": {
      const style = baseStyle(merged);
      const opacity = opacityOf(attr(element, styles, "opacity"));
      const width = Number(element.getAttribute("width") ?? 0);
      const height = Number(element.getAttribute("height") ?? 0);
      if (isAxisAligned(matrix) && width > 0 && height > 0) {
        const rx = Number(element.getAttribute("rx") ?? 0);
        if (rx > 0) style.cornerRadius = { topLeft: rx, topRight: rx, bottomRight: rx, bottomLeft: rx };
        ctx.nodes.push(
          createNode("rect", {
            name: element.getAttribute("id") || "rect",
            x: Number(element.getAttribute("x") ?? 0) + matrix[4],
            y: Number(element.getAttribute("y") ?? 0) + matrix[5],
            width,
            height,
            opacity,
            style,
          }),
        );
        return true;
      }
      pushPathNode(ctx, element, styles, matrix, rectVector(element), "rect", merged);
      return true;
    }
    case "circle":
    case "ellipse": {
      const style = baseStyle(merged);
      const opacity = opacityOf(attr(element, styles, "opacity"));
      const cx = Number(element.getAttribute("cx") ?? 0);
      const cy = Number(element.getAttribute("cy") ?? 0);
      const rx = tag === "circle" ? Number(element.getAttribute("r") ?? 0) : Number(element.getAttribute("rx") ?? 0);
      const ry = tag === "circle" ? rx : Number(element.getAttribute("ry") ?? 0);
      if (isAxisAligned(matrix) && rx > 0 && ry > 0) {
        ctx.nodes.push(
          createNode("ellipse", {
            name: element.getAttribute("id") || tag,
            x: cx - rx + matrix[4],
            y: cy - ry + matrix[5],
            width: rx * 2,
            height: ry * 2,
            opacity,
            style,
          }),
        );
        return true;
      }
      pushPathNode(ctx, element, styles, matrix, ellipseVector(element, tag === "circle"), tag, merged);
      return true;
    }
    case "line": {
      const x1 = Number(element.getAttribute("x1") ?? 0);
      const y1 = Number(element.getAttribute("y1") ?? 0);
      const x2 = Number(element.getAttribute("x2") ?? 0);
      const y2 = Number(element.getAttribute("y2") ?? 0);
      pushPathNode(
        ctx,
        element,
        styles,
        matrix,
        { closed: false, anchors: [makeAnchor(x1, y1), makeAnchor(x2, y2)] },
        "line",
        merged,
      );
      return true;
    }
    case "polyline":
    case "polygon": {
      const vector = pointsVector(element, tag === "polygon");
      if (!vector) return false;
      pushPathNode(ctx, element, styles, matrix, vector, tag, merged);
      return true;
    }
    case "path": {
      const subpaths = parsePathData(element.getAttribute("d") ?? "");
      if (!subpaths) return false;
      // 单轮廓模型表达不了"多子路径 + 填充"里的洞：整元素栅格化
      if (subpaths.length > 1 && baseStyle(merged).fill) return false;
      subpaths.forEach((subpath, index) => {
        pushPathNode(ctx, element, styles, matrix, subpath, subpaths.length > 1 ? `path-${index + 1}` : "path", merged);
      });
      return true;
    }
    case "text":
      return textOf(ctx, element, styles, matrix, merged);
    case "image":
      return imageNode(ctx, element, styles, matrix);
    case "use": {
      const href = element.getAttribute("href") ?? element.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (!href || !href.startsWith("#")) return false;
      const target = ctx.doc.getElementById(href.slice(1));
      if (!target) return false;
      return parseElement(ctx, target, matrix, merged);
    }
    default:
      return false;
  }
}

/** 逐元素降级用：这些标签自身不是图形，不能单独栅格化。 */
const RASTERABLE = new Set([
  "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "image", "use",
]);

/** 解析失败时退一步：把这一棵子树渲染成图片贴回原位置（整元素级降级）。 */
async function parseElement(
  ctx: ParseContext,
  element: Element,
  parentMatrix: Mat,
  inherited: InheritedStyle,
): Promise<boolean> {
  try {
    if (await parseNode(ctx, element, parentMatrix, inherited)) return true;
  } catch {
    // 无法映射的渐变等：落到整元素栅格化，不让一份 SVG 因一个元素整份失败
  }
  return rasterizeElement(ctx, element, parentMatrix);
}

function measureElement(ctx: ParseContext, element: Element, parentMatrix: Mat): { x: number; y: number; width: number; height: number } | null {
  const host = document.createElementNS(SVG_NS, "svg");
  const { x, y, width, height } = ctx.viewBox;
  host.setAttribute("width", String(width));
  host.setAttribute("height", String(height));
  host.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
  host.style.cssText = "position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none";
  const probe = document.createElementNS(SVG_NS, "g");
  const ancestor = document.createElementNS(SVG_NS, "g");
  ancestor.setAttribute("transform", `matrix(${parentMatrix.join(" ")})`);
  ancestor.appendChild(sanitizeSvgSubtree(element));
  probe.appendChild(ancestor);
  host.appendChild(probe);
  document.body.appendChild(host);
  try {
    const box = probe.getBBox();
    if (!(box.width > 0) || !(box.height > 0)) return null;
    return { x: box.x - x, y: box.y - y, width: box.width, height: box.height };
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

function standaloneSvg(
  ctx: ParseContext,
  element: Element,
  parentMatrix: Mat,
  box: { x: number; y: number; width: number; height: number },
): string {
  const serializer = new XMLSerializer();
  const defs = Array.from(ctx.root.querySelectorAll("defs"))
    .map((entry) => serializer.serializeToString(sanitizeSvgSubtree(entry)))
    .join("");
  const styles = Array.from(ctx.root.querySelectorAll("style"))
    .map((entry) => {
      const clone = entry.cloneNode(true) as Element;
      clone.textContent = sanitizeSvgStyleText(clone.textContent ?? "");
      return serializer.serializeToString(clone);
    })
    .join("");
  const inner = serializer.serializeToString(sanitizeSvgSubtree(element));
  const translate = `translate(${-ctx.viewBox.x} ${-ctx.viewBox.y})`;
  return (
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `viewBox="${box.x} ${box.y} ${box.width} ${box.height}" width="${box.width * 2}" height="${box.height * 2}">` +
    defs +
    styles +
    `<g transform="${translate}"><g transform="matrix(${parentMatrix.join(" ")})">${inner}</g></g></svg>`
  );
}

async function rasterizeElement(ctx: ParseContext, element: Element, parentMatrix: Mat): Promise<boolean> {
  const tag = element.tagName.toLowerCase();
  if (!RASTERABLE.has(tag)) return false;
  if (ctx.rasterized.length >= 200 || ctx.nodes.length > MAX_NODES) return false;
  const box = measureElement(ctx, element, parentMatrix);
  if (!box) return false;
  const pixels = box.width * box.height * 4;
  if (pixels > 40_000_000) return false;

  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standaloneSvg(ctx, element, parentMatrix, box))}`;
  try {
    await image.decode();
  } catch {
    return false;
  }
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(box.width * scale));
  canvas.height = Math.max(1, Math.round(box.height * scale));
  const canvasCtx = canvas.getContext("2d");
  if (!canvasCtx) return false;
  canvasCtx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return false;
  const asset = await putAsset(new Uint8Array(await blob.arrayBuffer()));
  if (!asset.ok) return false;

  const name = element.getAttribute("id") || tag;
  ctx.nodes.push(
    createNode("image", {
      name,
      x: box.x,
      y: box.y,
      width: Math.max(1, Math.round(box.width)),
      height: Math.max(1, Math.round(box.height)),
      opacity: opacityOf(attr(element, styleMap(element), "opacity")),
      image: {
        assetId: asset.id,
        naturalWidth: asset.width,
        naturalHeight: asset.height,
        crop: { x: 0, y: 0, width: asset.width, height: asset.height },
      },
    }),
  );
  ctx.rasterized.push(name);
  return true;
}

/** 解析入口：返回节点、尺寸与提示；无法映射时让调用方按图片插入。 */
export async function parseSvg(text: string): Promise<SvgImportOutcome> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
    return { status: "fallback", reason: "invalid-svg" };
  }

  const viewBox = parseNumberList(root.getAttribute("viewBox"));
  const width = viewBox[2] ?? Number(root.getAttribute("width")) ?? 0;
  const height = viewBox[3] ?? Number(root.getAttribute("height")) ?? 0;
  if (!(width > 0) || !(height > 0)) return { status: "fallback", reason: "no-size" };

  const ctx: ParseContext = {
    doc,
    root,
    viewBox: { x: viewBox[0] ?? 0, y: viewBox[1] ?? 0, width, height },
    warnings: [],
    rasterized: [],
    missingFonts: new Set(),
    knownFonts: new Set(fontFamilies().map((family) => family.toLowerCase())),
    depth: 0,
    nodes: [],
  };
  const base: Mat = viewBox.length >= 4 ? [1, 0, 0, 1, -(viewBox[0] ?? 0), -(viewBox[1] ?? 0)] : IDENTITY;
  const ok = await parseElement(ctx, root, base, {});
  if (!ok) return { status: "fallback", reason: "unsupported-feature" };
  return {
    status: "ok",
    result: {
      width,
      height,
      nodes: ctx.nodes,
      warnings: ctx.warnings,
      rasterized: ctx.rasterized,
      missingFonts: [...ctx.missingFonts],
    },
  };
}
