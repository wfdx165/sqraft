/**
 * SVG 实现的 RenderBackend：与 Canvas2DBackend 并列，由 `drawDocument` 驱动。
 *
 * 不自己遍历文档：变换、裁剪、不透明度、蒙版、效果的顺序都跟 canvas 后端保持一致，
 * 只把每次绘制翻译成 SVG 文本。文本布局复用 core 的 `layoutText`，度量由宿主注入。
 */

import {
  ZERO_CORNER_RADIUS,
  cornerRadiusOf,
  fontFamilyOf,
  fontString,
  fontSizeOf,
  layoutText,
  letterSpacingPx,
  type CornerRadius,
  type DocNode,
  type Rect,
  type VectorPath,
} from "@sqraft/core";
import type { RenderBackend, RenderEffect, ResolvedImage, Viewport } from "./backend";

/** 导出范围内需要内嵌的字体：字节由渲染层提供（系统字体没有字节，不会出现在这里）。 */
export interface SvgFontFace {
  family: string;
  weight: number;
  style: string;
  mime: string;
  bytes: Uint8Array;
}

export interface SvgBackendOptions {
  viewport: Viewport;
  /** 文本度量，与画布同源（桌面端传 `renderer/text-metrics` 的 measureText）。 */
  measure?: (text: string, font: string) => number;
  /** 需要内嵌的字体。 */
  fonts?: readonly SvgFontFace[];
}

/** 2×3 仿射矩阵：[a b c d e f]，与 SVG matrix() 同序。 */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return IDENTITY;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

function translateMatrix(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y];
}

function rotateMatrix(deg: number, cx: number, cy: number): Matrix {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function num(v: number): string {
  const r = round2(v);
  return String(Object.is(r, -0) ? 0 : r);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return escapeXml(text).replace(/'/g, "&#39;");
}

function base64(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

/**
 * CSS 字符串字面量：字体族/风格来自导入文件，不可信。
 * `]]>` 用标准的 CDATA 续接写法，避免提前结束 `<style><![CDATA[…]]></style>`。
 */
function cssString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/]]>/g, "]]]]><![CDATA[>");
  return `'${escaped}'`;
}

/** 四角独立的圆角矩形路径（与 canvas 后端的 roundedPath 同形）。 */
export function roundedRectPath(x: number, y: number, w: number, h: number, radius: CornerRadius): string {
  const max = Math.max(0, Math.min(w, h) / 2);
  const tl = Math.min(Math.max(0, radius.topLeft ?? 0), max);
  const tr = Math.min(Math.max(0, radius.topRight ?? 0), max);
  const br = Math.min(Math.max(0, radius.bottomRight ?? 0), max);
  const bl = Math.min(Math.max(0, radius.bottomLeft ?? 0), max);
  const parts: string[] = [`M${num(x + tl)} ${num(y)}`];
  parts.push(`L${num(x + w - tr)} ${num(y)}`);
  if (tr) parts.push(`A${num(tr)} ${num(tr)} 0 0 1 ${num(x + w)} ${num(y + tr)}`);
  parts.push(`L${num(x + w)} ${num(y + h - br)}`);
  if (br) parts.push(`A${num(br)} ${num(br)} 0 0 1 ${num(x + w - br)} ${num(y + h)}`);
  parts.push(`L${num(x + bl)} ${num(y + h)}`);
  if (bl) parts.push(`A${num(bl)} ${num(bl)} 0 0 1 ${num(x)} ${num(y + h - bl)}`);
  parts.push(`L${num(x)} ${num(y + tl)}`);
  if (tl) parts.push(`A${num(tl)} ${num(tl)} 0 0 1 ${num(x + tl)} ${num(y)}`);
  parts.push("Z");
  return parts.join(" ");
}

/** 向量路径转 d（三次贝塞尔，与 canvas 的 drawPath 同源）。 */
export function vectorPathData(node: DocNode, vector: VectorPath): string {
  const anchors = vector.anchors;
  if (anchors.length < 2) return "";
  const ox = node.x;
  const oy = node.y;
  const parts: string[] = [`M${num(ox + anchors[0].x)} ${num(oy + anchors[0].y)}`];
  const segments = vector.closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < segments; i += 1) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    const curved = a.outX !== 0 || a.outY !== 0 || b.inX !== 0 || b.inY !== 0;
    if (curved) {
      parts.push(
        `C${num(ox + a.x + a.outX)} ${num(oy + a.y + a.outY)} ${num(ox + b.x + b.inX)} ${num(oy + b.y + b.inY)} ${num(ox + b.x)} ${num(oy + b.y)}`,
      );
    } else {
      parts.push(`L${num(ox + b.x)} ${num(oy + b.y)}`);
    }
  }
  if (vector.closed) parts.push("Z");
  return parts.join(" ");
}

function paintAttrs(fill: string | undefined, stroke: string | undefined, strokeWidth: number): string {
  const attrs: string[] = [];
  if (fill) attrs.push(`fill="${escapeAttr(fill)}"`);
  else attrs.push(`fill="none"`);
  if (stroke) {
    attrs.push(`stroke="${escapeAttr(stroke)}"`, `stroke-width="${num(strokeWidth)}"`);
  }
  return attrs.join(" ");
}

/** 与 canvas 的 effects 渲染顺序一致的滤镜链（背景模糊没有对应，交给栅格化兜底）。 */
function filterBody(effects: readonly RenderEffect[]): string | null {
  const steps: string[] = [];
  let current = "SourceGraphic";
  let index = 0;
  for (const effect of effects) {
    if (effect.type === "backdrop-blur") continue;
    if (effect.type === "drop-shadow") {
      const sigma = num(Math.max(0, effect.blur) / 2);
      const name = `s${index}`;
      if (effect.spread === 0) {
        // 没有扩散时 feDropShadow 与 canvas 等价：源画在阴影之上
        steps.push(
          `<feDropShadow in="${current}" dx="${num(effect.x)}" dy="${num(effect.y)}" stdDeviation="${sigma}" flood-color="${escapeAttr(effect.color)}" result="${name}"/>`,
        );
      } else {
        // 有扩散时不能把膨胀后的图形当"源"（会把元素本身放大）：
        // 只对染色轮廓做形态学膨胀，最后把原始 current 叠回最上层。
        const flood = `${name}f`;
        const shape = `${name}s`;
        const grown = `${name}m`;
        const offset = `${name}o`;
        const blurred = `${name}b`;
        steps.push(`<feFlood flood-color="${escapeAttr(effect.color)}" result="${flood}"/>`);
        steps.push(`<feComposite in="${flood}" in2="${current}" operator="in" result="${shape}"/>`);
        steps.push(
          `<feMorphology in="${shape}" operator="${effect.spread > 0 ? "dilate" : "erode"}" radius="${num(Math.abs(effect.spread))}" result="${grown}"/>`,
        );
        steps.push(`<feOffset in="${grown}" dx="${num(effect.x)}" dy="${num(effect.y)}" result="${offset}"/>`);
        steps.push(`<feGaussianBlur in="${offset}" stdDeviation="${sigma}" result="${blurred}"/>`);
        steps.push(
          `<feMerge result="${name}"><feMergeNode in="${blurred}"/><feMergeNode in="${current}"/></feMerge>`,
        );
      }
      current = name;
      index += 1;
      continue;
    }
    if (effect.type === "inner-shadow") {
      const sigma = num(Math.max(0, effect.blur) / 2);
      const flood = `i${index}f`;
      const spread = `i${index}s`;
      const off = `i${index}o`;
      const blur = `i${index}b`;
      const cut = `i${index}c`;
      const masked = `i${index}m`;
      const merged = `i${index}r`;
      steps.push(`<feFlood flood-color="${escapeAttr(effect.color)}" result="${flood}"/>`);
      // 扩散：canvas 把轮廓按 spread 放大/缩小，SVG 用形态学等价表达
      let alpha = "SourceAlpha";
      if (effect.spread !== 0) {
        steps.push(
          `<feMorphology in="SourceAlpha" operator="${effect.spread > 0 ? "dilate" : "erode"}" radius="${num(Math.abs(effect.spread))}" result="${spread}"/>`,
        );
        alpha = spread;
      }
      steps.push(`<feOffset in="${alpha}" dx="${num(effect.x)}" dy="${num(effect.y)}" result="${off}"/>`);
      steps.push(`<feGaussianBlur in="${off}" stdDeviation="${sigma}" result="${blur}"/>`);
      steps.push(`<feComposite in="${flood}" in2="${blur}" operator="out" result="${cut}"/>`);
      steps.push(`<feComposite in="${cut}" in2="SourceAlpha" operator="in" result="${masked}"/>`);
      steps.push(
        `<feMerge result="${merged}"><feMergeNode in="${current}"/><feMergeNode in="${masked}"/></feMerge>`,
      );
      current = merged;
      index += 1;
      continue;
    }
    if (effect.type === "layer-blur") {
      const name = `b${index}`;
      steps.push(`<feGaussianBlur in="${current}" stdDeviation="${num(Math.max(0, effect.radius) / 2)}" result="${name}"/>`);
      current = name;
      index += 1;
    }
  }
  return steps.length ? steps.join("") : null;
}

interface OpenGroup {
  /** pushEffects 开了 filter 组时记下来，popEffects 负责关 */
  filter?: string;
  /** layer-blur 额外套了一层轮廓裁剪 */
  clipWrap?: boolean;
}

interface MaskFrame {
  /** push 时正文在 parts 里的下标 */
  start: number;
}

export class SvgBackend implements RenderBackend {
  private readonly vp: Viewport;
  private readonly measureFn: (text: string, font: string) => number;
  private readonly fonts: readonly SvgFontFace[];
  private parts: string[] = [];
  private defs: string[] = [];
  private groups: OpenGroup[] = [];
  /** pushEffects 的栈：记下这一层是否额外套了轮廓裁剪 */
  private effectWraps: boolean[] = [];
  private masks: MaskFrame[] = [];
  private matrixStack: Matrix[] = [IDENTITY];
  private clipSeq = 0;
  private maskSeq = 0;
  private filterSeq = 0;

  constructor(options: SvgBackendOptions) {
    this.vp = options.viewport;
    this.fonts = options.fonts ?? [];
    this.measureFn = options.measure ?? ((text, font) => text.length * fontSizeFromFont(font) * 0.58);
  }

  /** 当前坐标系 → 世界坐标的矩阵。 */
  private get matrix(): Matrix {
    return this.matrixStack[this.matrixStack.length - 1];
  }

  private pushMatrix(m: Matrix): void {
    this.matrixStack.push(multiply(this.matrix, m));
  }

  private open(attrs: string): void {
    this.parts.push(`<g${attrs ? ` ${attrs}` : ""}>`);
    this.groups.push({});
  }

  beginFrame(_viewport?: Viewport): void {
    this.parts = [];
    this.defs = [];
    this.groups = [];
    this.effectWraps = [];
    this.masks = [];
    this.matrixStack = [IDENTITY];
    this.clipSeq = 0;
    this.maskSeq = 0;
    this.filterSeq = 0;
  }

  endFrame(): void {
    // 组由调用方的 push/pop 配对关闭，这里不需要补
  }

  pushTransform(x: number, y: number, rotation = 0, width = 0, height = 0): void {
    const m = rotation
      ? multiply(translateMatrix(x, y), rotateMatrix(rotation, width / 2, height / 2))
      : translateMatrix(x, y);
    this.pushMatrix(m);
    const transform = rotation
      ? `translate(${num(x)} ${num(y)}) rotate(${num(rotation)} ${num(width / 2)} ${num(height / 2)})`
      : `translate(${num(x)} ${num(y)})`;
    this.open(`transform="${transform}"`);
  }

  popTransform(): void {
    this.closeGroup();
    this.matrixStack.pop();
  }

  pushClip(x: number, y: number, width: number, height: number, radius: CornerRadius): void {
    const id = `clip${this.clipSeq++}`;
    this.defs.push(
      `<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${roundedRectPath(x, y, width, height, radius)}"/></clipPath>`,
    );
    this.open(`clip-path="url(#${id})"`);
  }

  popClip(): void {
    this.closeGroup();
  }

  pushOpacity(alpha: number): void {
    this.open(`opacity="${num(Math.max(0, Math.min(1, alpha)))}"`);
  }

  popOpacity(): void {
    this.closeGroup();
  }

  pushAlpha(alpha: number): void {
    this.open(`opacity="${num(Math.max(0, Math.min(1, alpha)))}"`);
  }

  popAlpha(): void {
    this.closeGroup();
  }

  pushEffects(node: DocNode, effects: readonly RenderEffect[]): boolean | void {
    const body = filterBody(effects);
    let filterId: string | undefined;
    if (body) {
      filterId = `fx${this.filterSeq++}`;
      this.defs.push(
        `<filter id="${filterId}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${body}</filter>`,
      );
    }
    // layer-blur 在 canvas 上会被节点自身轮廓裁住（容器也裁到自己的矩形）：
    // 旋转与圆角写进 clipPath 的 path 上
    const needsClip = effects.some((e) => e.type === "layer-blur");
    if (needsClip) {
      const clipId = `clip${this.clipSeq++}`;
      const rotate = node.rotation
        ? ` transform="rotate(${num(node.rotation)} ${num(node.x + node.width / 2)} ${num(node.y + node.height / 2)})"`
        : "";
      this.defs.push(
        `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="${roundedRectPath(node.x, node.y, node.width, node.height, cornerRadiusOf(node.style))}"${rotate}/></clipPath>`,
      );
      this.open(`clip-path="url(#${clipId})"`);
    }
    this.open(filterId ? `filter="url(#${filterId})"` : "");
    this.effectWraps.push(needsClip);
  }

  popEffects(): void {
    this.closeGroup();
    if (this.effectWraps.pop()) this.closeGroup();
  }

  drawRect(
    node: DocNode,
    fill?: string,
    stroke?: string,
    strokeWidth = 1,
    radius: CornerRadius = ZERO_CORNER_RADIUS,
    shadow = false,
  ): void {
    const d = roundedRectPath(node.x, node.y, node.width, node.height, radius);
    const attrs = [paintAttrs(fill, stroke, strokeWidth)];
    if (shadow) {
      attrs.push(`style="filter:drop-shadow(0 10px 32px rgba(15,23,42,0.16))"`);
    }
    this.leaf(node, `<path d="${d}" ${attrs.join(" ")}/>`);
  }

  drawEllipse(node: DocNode, fill?: string, stroke?: string, strokeWidth = 1): void {
    const attrs = paintAttrs(fill, stroke, strokeWidth);
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    this.leaf(
      node,
      `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(Math.abs(node.width / 2))}" ry="${num(Math.abs(node.height / 2))}" ${attrs}/>`,
    );
  }

  drawLine(node: DocNode, stroke = "#000", strokeWidth = 1): void {
    // 与 canvas 一致：线段不吃旋转
    this.parts.push(
      `<line x1="${num(node.x)}" y1="${num(node.y)}" x2="${num(node.x + node.width)}" y2="${num(node.y + node.height)}" stroke="${escapeAttr(stroke)}" stroke-width="${num(strokeWidth)}"/>`,
    );
  }

  drawPath(node: DocNode, vector: VectorPath, fill?: string, stroke?: string, strokeWidth = 1): void {
    const d = vectorPathData(node, vector);
    if (!d) return;
    const dash = stroke ? `stroke-linecap="round" stroke-linejoin="round"` : "";
    this.leaf(node, `<path d="${d}" ${paintAttrs(fill, stroke, strokeWidth)} ${dash}/>`);
  }

  drawPolygon(
    node: DocNode,
    points: ReadonlyArray<{ x: number; y: number }>,
    fill?: string,
    stroke?: string,
    strokeWidth = 1,
  ): void {
    if (points.length < 3) return;
    const d = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${num(node.x + p.x)} ${num(node.y + p.y)}`)
      .join(" ")
      .concat(" Z");
    const dash = stroke ? `stroke-linecap="round" stroke-linejoin="round"` : "";
    this.leaf(node, `<path d="${d}" ${paintAttrs(fill, stroke, strokeWidth)} ${dash}/>`);
  }

  drawText(node: DocNode, fill = "#000", stroke?: string): void {
    const style = node.style;
    const size = fontSizeOf(style);
    const spacing = letterSpacingPx(style);
    const mode = node.textAutoResize ?? "auto-width";
    const measure = (text: string): number => this.measureFn(text, fontString(style));
    const layout = layoutText(node.text ?? "", style, {
      measure,
      listType: node.listType,
      maxWidth: mode === "auto-width" ? undefined : node.width,
      maxHeight: mode === "fixed" ? node.height : undefined,
      truncate: node.truncate,
    });

    let offsetY = 0;
    if (mode !== "auto-width") {
      const va = style.textVerticalAlign ?? "top";
      if (va === "middle") offsetY = Math.max(0, (node.height - layout.height) / 2);
      else if (va === "bottom") offsetY = Math.max(0, node.height - layout.height);
    }

    const fontFamily = fontFamilyOf(style);
    const fontAttrs = [
      `font-family="${escapeAttr(fontFamily)}"`,
      `font-size="${num(size)}"`,
      `font-weight="${num(style.fontWeight ?? 400)}"`,
      style.fontStyle === "italic" ? `font-style="italic"` : "",
      spacing ? `letter-spacing="${num(spacing)}"` : "",
      fill ? `fill="${escapeAttr(fill)}"` : `fill="none"`,
      stroke ? `stroke="${escapeAttr(stroke)}" stroke-width="${num(style.strokeWidth ?? 1)}"` : "",
      `xml:space="preserve"`,
    ]
      .filter(Boolean)
      .join(" ");

    const lines: string[] = [];
    let y = node.y + offsetY;
    layout.lines.forEach((line, index) => {
      const prev = layout.lines[index - 1];
      if (prev && prev.paragraph !== line.paragraph) y += style.paragraphSpacing ?? 0;
      const baseline = y + (layout.lineHeight - size) / 2 + size * 0.8;
      const left = node.x + line.indent;
      const avail = Math.max(1, node.width - line.indent);

      if (line.marker) {
        const markerWidth = measure(line.marker) + spacing * Math.max(0, [...line.marker].length - 1);
        lines.push(
          `<text x="${num(node.x + Math.max(0, line.indent - markerWidth - size * 0.35))}" y="${num(baseline)}" ${fontAttrs}>${escapeXml(line.marker)}</text>`,
        );
      }

      const justify =
        style.textAlign === "justify" && layout.lines[index + 1] !== undefined && layout.lines[index + 1].paragraph === line.paragraph;
      let drawX = left;
      let totalWidth = line.width;
      if (style.textAlign === "center") drawX = left + (avail - line.width) / 2;
      else if (style.textAlign === "right") drawX = left + avail - line.width;

      if (justify && line.text.includes(" ")) {
        // 逐词定位：与 canvas 的「每个空格多拉一份」等价
        const words = line.text.split(" ");
        const extra = Math.max(0, (avail - line.width) / Math.max(1, words.length - 1));
        let cursor = left;
        const spans: string[] = [];
        words.forEach((word, i) => {
          if (i > 0) {
            spans.push(`<tspan x="${num(cursor)}"> </tspan>`);
            cursor += measure(" ") + spacing + extra;
          }
          spans.push(`<tspan x="${num(cursor)}">${escapeXml(word)}</tspan>`);
          cursor += measure(word) + spacing * Math.max(0, [...word].length);
        });
        lines.push(`<text y="${num(baseline)}" ${fontAttrs}>${spans.join("")}</text>`);
        drawX = left;
        totalWidth = avail;
      } else {
        lines.push(
          `<text x="${num(drawX)}" y="${num(baseline)}" text-anchor="start" ${fontAttrs}>${escapeXml(line.text)}</text>`,
        );
        totalWidth = line.width;
      }

      if (style.textDecoration === "underline" || style.textDecoration === "strikethrough") {
        const dy = style.textDecoration === "underline" ? size * 0.14 : -size * 0.28;
        const width = Math.max(1, size * 0.06);
        lines.push(
          `<line x1="${num(drawX)}" y1="${num(baseline + dy)}" x2="${num(drawX + Math.max(line.width, totalWidth))}" y2="${num(baseline + dy)}" stroke="${escapeAttr(fill)}" stroke-width="${num(width)}"/>`,
        );
      }

      y += layout.lineHeight;
    });

    if (node.rotation) {
      this.parts.push(
        `<g transform="rotate(${num(node.rotation)} ${num(node.x + node.width / 2)} ${num(node.y + node.height / 2)})">${lines.join("")}</g>`,
      );
    } else {
      this.parts.push(lines.join(""));
    }
  }

  drawImage(node: DocNode, image: ResolvedImage, crop: Rect, radius: CornerRadius = ZERO_CORNER_RADIUS): void {
    const href = image.href;
    if (!href) {
      this.drawImagePlaceholder(node, radius);
      return;
    }
    const clipId = `clip${this.clipSeq++}`;
    this.defs.push(
      `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="${roundedRectPath(node.x, node.y, node.width, node.height, radius)}"/></clipPath>`,
    );
    // 把原图 crop 区域映射到节点框：两个方向各自拉伸（与 canvas drawImage 一致）
    const sx = node.width / Math.max(1, crop.width);
    const sy = node.height / Math.max(1, crop.height);
    const w = image.width * sx;
    const h = image.height * sy;
    const x = node.x - crop.x * sx;
    const y = node.y - crop.y * sy;
    const rotating = node.rotation
      ? ` transform="rotate(${num(node.rotation)} ${num(node.x + node.width / 2)} ${num(node.y + node.height / 2)})"`
      : "";
    this.parts.push(
      `<g clip-path="url(#${clipId})"${rotating}><image x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="none" href="${escapeAttr(href)}"/></g>`,
    );
  }

  drawImagePlaceholder(node: DocNode, radius: CornerRadius = ZERO_CORNER_RADIUS): void {
    const d = roundedRectPath(node.x, node.y, node.width, node.height, radius);
    this.leaf(
      node,
      `<path d="${d}" fill="#eef0f4" stroke="#c7ccd6" stroke-width="1"/><path d="M${num(node.x)} ${num(node.y)} L${num(node.x + node.width)} ${num(node.y + node.height)}" stroke="#c7ccd6" stroke-width="1"/>`,
    );
  }

  drawImageInRect(image: ResolvedImage, rect: Rect, fit: "cover" | "contain" | "tile"): void {
    const href = image.href;
    if (!href) return;
    if (fit === "tile") {
      const id = `pat${this.clipSeq++}`;
      this.defs.push(
        `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${num(rect.x)}" y="${num(rect.y)}" width="${num(image.width)}" height="${num(image.height)}"><image href="${escapeAttr(href)}" width="${num(image.width)}" height="${num(image.height)}"/></pattern>`,
      );
      this.parts.push(
        `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" fill="url(#${id})"/>`,
      );
      return;
    }
    const clipId = `clip${this.clipSeq++}`;
    this.defs.push(
      `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}"/></clipPath>`,
    );
    this.parts.push(
      `<g clip-path="url(#${clipId})"><image x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" preserveAspectRatio="${fit === "cover" ? "xMidYMid slice" : "xMidYMid meet"}" href="${escapeAttr(href)}"/></g>`,
    );
  }

  /** 栅格化兜底：把已经渲染好的位图贴回原位置。矩形是世界坐标。 */
  drawRasterFallback(raster: { href: string; rect: Rect }): void {
    const inverse = invert(this.matrix);
    const m = `matrix(${inverse.map((v) => num(v)).join(" ")})`;
    this.parts.push(
      `<g transform="${m}"><image x="${num(raster.rect.x)}" y="${num(raster.rect.y)}" width="${num(raster.rect.width)}" height="${num(raster.rect.height)}" preserveAspectRatio="none" href="${escapeAttr(raster.href)}"/></g>`,
    );
  }

  pushRootCache(): "uncached" {
    return "uncached";
  }

  popRootCache(): void {}

  noteIncomplete(): void {}

  pushMaskLayer(): boolean | void {
    this.masks.push({ start: this.parts.length });
  }

  popMaskLayer(drawMask: () => void, alpha = 1): void {
    const frame = this.masks.pop();
    if (!frame) return;
    const body = this.parts.splice(frame.start);
    // 蒙版形状画在独立缓冲里，画完再包进 <mask>
    const outer = this.parts;
    this.parts = [];
    drawMask();
    const shape = this.parts.join("");
    this.parts = outer;
    const id = `mask${this.maskSeq++}`;
    this.defs.push(
      `<mask id="${id}" maskUnits="userSpaceOnUse" style="mask-type:alpha" maskContentUnits="userSpaceOnUse">${shape}</mask>`,
    );
    const opacity = alpha < 1 ? ` opacity="${num(alpha)}"` : "";
    this.parts.push(`<g mask="url(#${id})"${opacity}>${body.join("")}</g>`);
  }

  /** 别忘了在 drawDocument 之后调用。 */
  toSvg(): string {
    const w = Math.max(1, round2(this.vp.width));
    const h = Math.max(1, round2(this.vp.height));
    const style = this.styleSheet();
    const defs = `${style}${this.defs.join("")}`;
    const body = this.parts.join("");
    const offset =
      this.vp.x || this.vp.y ? `<g transform="translate(${num(-this.vp.x)} ${num(-this.vp.y)})">` : "";
    const offsetEnd = offset ? "</g>" : "";
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${num(w)}" height="${num(h)}" viewBox="0 0 ${num(w)} ${num(h)}">${defs ? `<defs>${defs}</defs>` : ""}${offset}${body}${offsetEnd}</svg>`;
  }

  private styleSheet(): string {
    if (this.fonts.length === 0) return "";
    const rules = this.fonts.map(
      (font) =>
        `@font-face{font-family:${cssString(font.family)};font-weight:${font.weight};font-style:${cssString(font.style)};src:url(data:${font.mime};base64,${base64(font.bytes)})}`,
    );
    return `<style><![CDATA[${rules.join("")}]]></style>`;
  }

  private leaf(node: DocNode, markup: string): void {
    if (node.rotation) {
      this.parts.push(
        `<g transform="rotate(${num(node.rotation)} ${num(node.x + node.width / 2)} ${num(node.y + node.height / 2)})">${markup}</g>`,
      );
      return;
    }
    this.parts.push(markup);
  }

  private closeGroup(): void {
    this.groups.pop();
    this.parts.push("</g>");
  }
}

function fontSizeFromFont(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match ? Number(match[1]) : 16;
}
