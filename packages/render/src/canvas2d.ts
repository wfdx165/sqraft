/** Canvas 2D 实现的 RenderBackend。 */

import { TEXT_LINE_HEIGHT, type DocNode, type VectorPath } from "@sqraft/core";
import type { RenderBackend, Viewport } from "./backend";

export class Canvas2DBackend implements RenderBackend {
  private ctx: CanvasRenderingContext2D;
  private vp: Viewport | null = null;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  beginFrame(vp: Viewport): void {
    this.vp = vp;
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

  pushTransform(x: number, y: number): void {
    this.ctx.save();
    this.ctx.translate(x, y);
  }

  popTransform(): void {
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

  drawRect(node: DocNode, fill?: string, stroke?: string, strokeWidth = 1, radius = 0, shadow = false): void {
    const ctx = this.ctx;
    ctx.save();
    this.applyRotation(node);
    ctx.beginPath();
    if (radius > 0 && typeof ctx.roundRect === "function") {
      ctx.roundRect(node.x, node.y, node.width, node.height, radius);
    } else {
      ctx.rect(node.x, node.y, node.width, node.height);
    }
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

  drawText(node: DocNode, fill = "#000"): void {
    const ctx = this.ctx;
    ctx.save();
    this.applyRotation(node);
    const size = node.style.fontSize ?? 14;
    const family = node.style.fontFamily ?? "sans-serif";
    const weight = node.style.fontWeight ?? 400;
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = fill;
    ctx.textBaseline = "top";
    const align = node.style.textAlign ?? "left";
    ctx.textAlign = align;
    const tx = align === "center" ? node.x + node.width / 2 : align === "right" ? node.x + node.width : node.x;
    // 按 \n 分行绘制（行高固定倍数，UI 测量与这里保持一致）
    const lineHeight = size * TEXT_LINE_HEIGHT;
    const lines = (node.text ?? "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], tx, node.y + i * lineHeight);
    }
    ctx.restore();
  }

  drawFrameOutline(node: DocNode): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1 / (this.vp?.zoom ?? 1);
    ctx.strokeRect(node.x, node.y, node.width, node.height);
    ctx.restore();
  }

  endFrame(): void {
    /* no-op */
  }
}
