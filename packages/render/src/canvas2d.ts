/** Canvas 2D 实现的 RenderBackend。 */

import {
  ZERO_CORNER_RADIUS,
  fontString,
  fontSizeOf,
  layoutText,
  letterSpacingPx,
  type CornerRadius,
  type DocNode,
  type VectorPath,
} from "@sqraft/core";
import type { RenderBackend, Viewport } from "./backend";

export class Canvas2DBackend implements RenderBackend {
  private ctx: CanvasRenderingContext2D;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  beginFrame(vp: Viewport): void {
    const canvas = this.ctx.canvas;
    const pw = Math.round(vp.width * vp.dpr);
    const ph = Math.round(vp.height * vp.dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = this.ctx;
    ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, vp.width, vp.height);
    // 应用视口变换（世界 → CSS 像素）
    ctx.scale(vp.zoom, vp.zoom);
    ctx.translate(-vp.x, -vp.y);
    ctx.lineJoin = "round";
  }

  pushTransform(x: number, y: number, rotation = 0, width = 0, height = 0): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    if (rotation) {
      ctx.translate(width / 2, height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.translate(-width / 2, -height / 2);
    }
  }

  popTransform(): void {
    this.ctx.restore();
  }

  pushClip(x: number, y: number, width: number, height: number, radius: CornerRadius): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    this.roundedPath(x, y, width, height, radius);
    ctx.clip();
  }

  popClip(): void {
    this.ctx.restore();
  }

  pushOpacity(alpha: number): void {
    this.ctx.save();
    this.ctx.globalAlpha *= Math.max(0, Math.min(1, alpha));
  }

  popOpacity(): void {
    this.ctx.restore();
  }

  private applyRotation(node: DocNode): void {
    if (node.rotation) {
      this.ctx.translate(node.x + node.width / 2, node.y + node.height / 2);
      this.ctx.rotate((node.rotation * Math.PI) / 180);
      this.ctx.translate(-(node.x + node.width / 2), -(node.y + node.height / 2));
    }
  }

  /** 四角独立的圆角矩形路径。 */
  private roundedPath(x: number, y: number, w: number, h: number, radius: CornerRadius): void {
    const ctx = this.ctx;
    const max = Math.max(0, Math.min(w, h) / 2);
    const tl = Math.min(radius.topLeft ?? 0, max);
    const tr = Math.min(radius.topRight ?? 0, max);
    const br = Math.min(radius.bottomRight ?? 0, max);
    const bl = Math.min(radius.bottomLeft ?? 0, max);
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr);
    ctx.lineTo(x + w, y + h - br);
    if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
    ctx.lineTo(x + bl, y + h);
    if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl);
    ctx.lineTo(x, y + tl);
    if (tl) ctx.arcTo(x, y, x + tl, y, tl);
    ctx.closePath();
  }

  drawRect(
    node: DocNode,
    fill?: string,
    stroke?: string,
    strokeWidth = 1,
    radius: CornerRadius = ZERO_CORNER_RADIUS,
    shadow = false,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    this.applyRotation(node);
    ctx.beginPath();
    this.roundedPath(node.x, node.y, node.width, node.height, radius);
    if (fill) {
      if (shadow) {
        ctx.shadowColor = "rgba(15, 23, 42, 0.16)";
        ctx.shadowBlur = 32;
        ctx.shadowOffsetY = 10;
      }
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawEllipse(node: DocNode, fill?: string, stroke?: string, strokeWidth = 1): void {
    const ctx = this.ctx;
    ctx.save();
    this.applyRotation(node);
    ctx.beginPath();
    ctx.ellipse(
      node.x + node.width / 2,
      node.y + node.height / 2,
      Math.abs(node.width / 2),
      Math.abs(node.height / 2),
      0,
      0,
      Math.PI * 2,
    );
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawLine(node: DocNode, stroke = "#000", strokeWidth = 1): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(node.x, node.y);
    ctx.lineTo(node.x + node.width, node.y + node.height);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
    ctx.restore();
  }

  drawPath(node: DocNode, vector: VectorPath, fill?: string, stroke?: string, strokeWidth = 1): void {
    const anchors = vector.anchors;
    if (anchors.length < 2) return;
    const ctx = this.ctx;
    const a0 = anchors[0];
    const ox = node.x;
    const oy = node.y;
    ctx.save();
    this.applyRotation(node);
    ctx.beginPath();
    ctx.moveTo(ox + a0.x, oy + a0.y);
    const segments = vector.closed ? anchors.length : anchors.length - 1;
    for (let i = 0; i < segments; i++) {
      const a = anchors[i];
      const b = anchors[(i + 1) % anchors.length];
      const curved = a.outX !== 0 || a.outY !== 0 || b.inX !== 0 || b.inY !== 0;
      if (curved) {
        ctx.bezierCurveTo(ox + a.x + a.outX, oy + a.y + a.outY, ox + b.x + b.inX, oy + b.y + b.inY, ox + b.x, oy + b.y);
      } else {
        ctx.lineTo(ox + b.x, oy + b.y);
      }
    }
    if (vector.closed) ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPolygon(
    node: DocNode,
    points: ReadonlyArray<{ x: number; y: number }>,
    fill?: string,
    stroke?: string,
    strokeWidth = 1,
  ): void {
    if (points.length < 3) return;
    const ctx = this.ctx;
    const ox = node.x;
    const oy = node.y;
    ctx.save();
    this.applyRotation(node);
    ctx.beginPath();
    ctx.moveTo(ox + points[0].x, oy + points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(ox + points[i].x, oy + points[i].y);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }
    ctx.restore();
  }

  drawText(node: DocNode, fill = "#000", stroke?: string): void {
    const ctx = this.ctx;
    const style = node.style;
    ctx.save();
    this.applyRotation(node);

    const font = fontString(style);
    const size = fontSizeOf(style);
    const spacing = letterSpacingPx(style);
    const mode = node.textAutoResize ?? "auto-width";
    ctx.font = font;
    const measure = (text: string): number => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };
    const withSpacing = (text: string): number =>
      measure(text) + spacing * Math.max(0, [...text].length - 1);

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

    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = fill;
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = style.strokeWidth ?? 1;
    }

    const paint = (text: string, x: number, baseline: number, spacingExtra = 0): number => {
      if (!text) return 0;
      if (spacing === 0 && spacingExtra === 0) {
        ctx.fillText(text, x, baseline);
        if (stroke) ctx.strokeText(text, x, baseline);
        return withSpacing(text);
      }
      let cursor = x;
      for (const ch of text) {
        ctx.fillText(ch, cursor, baseline);
        if (stroke) ctx.strokeText(ch, cursor, baseline);
        cursor += measure(ch) + spacing + (ch === " " ? spacingExtra : 0);
      }
      return cursor - x;
    };

    let y = node.y + offsetY;
    layout.lines.forEach((line, index) => {
      const prev = layout.lines[index - 1];
      if (prev && prev.paragraph !== line.paragraph) y += style.paragraphSpacing ?? 0;
      const baseline = y + (layout.lineHeight - size) / 2 + size * 0.8;
      const left = node.x + line.indent;
      const avail = Math.max(1, node.width - line.indent);

      if (line.marker) {
        const markerWidth = withSpacing(line.marker);
        paint(line.marker, node.x + Math.max(0, line.indent - markerWidth - size * 0.35), baseline);
      }

      const justify =
        style.textAlign === "justify" &&
        layout.lines[index + 1] !== undefined &&
        layout.lines[index + 1].paragraph === line.paragraph;
      let drawX = left;
      let drawn = line.width;
      if (style.textAlign === "center") drawX = left + (avail - line.width) / 2;
      else if (style.textAlign === "right") drawX = left + avail - line.width;

      if (justify && line.text.includes(" ")) {
        const spaces = line.text.split(" ").length - 1;
        const extra = Math.max(0, (avail - line.width) / Math.max(1, spaces));
        paint(line.text, left, baseline, extra);
        drawX = left;
        drawn = avail;
      } else if (style.textAlign === "justify") {
        paint(line.text, left, baseline);
        drawX = left;
      } else {
        paint(line.text, drawX, baseline);
      }

      if (style.textDecoration === "underline" || style.textDecoration === "strikethrough") {
        const total = Math.max(line.width, drawn);
        const dy = style.textDecoration === "underline" ? size * 0.14 : -size * 0.28;
        ctx.beginPath();
        ctx.strokeStyle = fill;
        ctx.lineWidth = Math.max(1, size * 0.06);
        ctx.moveTo(drawX, baseline + dy);
        ctx.lineTo(drawX + total, baseline + dy);
        ctx.stroke();
        if (stroke) ctx.strokeStyle = stroke;
      }

      y += layout.lineHeight;
    });
    ctx.restore();
  }

  endFrame(): void {
    /* no-op */
  }
}

/** 供 UI 叠加层复用的圆角路径（与画布渲染保持一致）。 */
export function traceCornerRadius(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: CornerRadius): void {
  const max = Math.max(0, Math.min(w, h) / 2);
  const tl = Math.min(radius.topLeft ?? 0, max);
  const tr = Math.min(radius.topRight ?? 0, max);
  const br = Math.min(radius.bottomRight ?? 0, max);
  const bl = Math.min(radius.bottomLeft ?? 0, max);
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  if (tl) ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}
