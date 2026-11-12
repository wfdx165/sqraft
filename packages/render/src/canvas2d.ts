/** Canvas 2D 实现的 RenderBackend。 */

import {
  ZERO_CORNER_RADIUS,
  cornerRadiusOf,
  effectLayerScale,
  effectPadding,
  fontString,
  fontSizeOf,
  layoutText,
  letterSpacingPx,
  polygonPoints,
  type CornerRadius,
  type DocNode,
  type Rect,
  type VectorPath,
} from "@sqraft/core";
import type { RenderBackend, RenderEffect, RenderShadowEffect, ResolvedImage, Viewport } from "./backend";

/** 两个矩形求交；无交集时退化为 1×1 的空层。 */
function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** 节点包围盒在父坐标系里的轴对齐外接矩形，并按效果外扩量放大。 */
function rotatedBounds(node: DocNode, pad: number): { x: number; y: number; width: number; height: number } {
  const { x, y, width, height, rotation } = node;
  if (!rotation) return { x: x - pad, y: y - pad, width: width + pad * 2, height: height + pad * 2 };
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = width * cos + height * sin;
  const h = width * sin + height * cos;
  const cx = x + width / 2;
  const cy = y + height / 2;
  return { x: cx - w / 2 - pad, y: cy - h / 2 - pad, width: w + pad * 2, height: h + pad * 2 };
}

/** 效果层：子树先画进离屏，pop 时施加效果/不透明度并合成回来。 */
interface EffectFrame {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** 离屏像素 / 文档单位 */
  scale: number;
  /** 层在父级坐标系中的矩形（已含效果外扩） */
  box: { x: number; y: number; width: number; height: number };
  /** 该层的父级坐标 → 层像素矩阵（合成与形状遮罩共用） */
  matrix: { a: number; b: number; c: number; d: number; e: number; f: number };
  /** 层在父级画布像素坐标里的矩形（背景模糊取样用） */
  device: { x: number; y: number; width: number; height: number };
  effects: readonly RenderEffect[];
  /** 组不透明度（合成时整体乘一次） */
  alpha: number;
  node: DocNode | null;
  /** 拿不到离屏上下文时退化为直通，保证 push/pop 仍然配对 */
  passthrough: boolean;
  /**
   * 世界坐标 → **本层**像素的矩阵。层位图的原点在父画布的 `device.x/y`，
   * 用主画布的矩阵换算会差出这段偏移，嵌套层（蒙版 / 不透明度 / 效果）就会被裁错位置。
   */
  worldToDevice: DOMMatrix | null;
}

export interface FrameStats {
  /** 本帧开启的离屏层数（效果层 + 不透明度层） */
  layers: number;
  /** 本帧离屏合成累计耗时（ms） */
  layerMs: number;
}

export class Canvas2DBackend implements RenderBackend {
  private main: CanvasRenderingContext2D;
  private frames: EffectFrame[] = [];
  /** 上一帧的离屏统计（开发态帧耗时 HUD 用；不影响绘制） */
  readonly stats: FrameStats = { layers: 0, layerMs: 0 };
  private viewport: Viewport | null = null;
  /** 页面坐标 → 设备像素（由 beginFrame 的视口推导） */
  private worldToDevice: DOMMatrix | null = null;

  constructor(ctx: CanvasRenderingContext2D) {
    this.main = ctx;
  }

  /** 当前绘制目标：效果层内为离屏上下文，否则为主画布。 */
  private get ctx(): CanvasRenderingContext2D {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1].ctx : this.main;
  }

  beginFrame(vp: Viewport): void {
    this.frames = [];
    this.stats.layers = 0;
    this.stats.layerMs = 0;
    this.viewport = vp;
    const k = vp.dpr * vp.zoom;
    this.worldToDevice = new DOMMatrix([k, 0, 0, k, -vp.x * k, -vp.y * k]);
    const canvas = this.main.canvas;
    const pw = Math.round(vp.width * vp.dpr);
    const ph = Math.round(vp.height * vp.dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = this.main;
    ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
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
    this.roundedPath(ctx, x, y, width, height, radius);
    ctx.clip();
  }

  popClip(): void {
    this.ctx.restore();
  }

  /**
   * 开启组不透明度层。`bounds` 是子树在**页面坐标系**里的包围盒；缺省退化为当前视口。
   * 层尺寸取「包围盒 ∩ 视口」，因此再大的画板在屏幕上也只有一层屏幕大小的离屏。
   * 不透明度层不做降采样 —— 那会把文字糊掉。
   */
  pushOpacity(alpha: number, bounds?: Rect): void {
    const clamped = Math.max(0, Math.min(1, alpha));
    const world = intersectRect(bounds ?? this.visibleWorldRect(), this.visibleWorldRect());
    this.openLayer(this.worldRectToLocal(world), {
      downsample: false,
      effects: [],
      alpha: clamped,
      node: null,
    });
  }

  popOpacity(): void {
    this.finishFrame();
  }

  pushEffects(node: DocNode, effects: readonly RenderEffect[]): void {
    const pad = effectPadding(effects);
    const box = intersectRect(rotatedBounds(node, pad), this.worldRectToLocal(this.visibleWorldRect()));
    this.openLayer(box, { downsample: true, effects, alpha: 1, node });
  }

  popEffects(): void {
    this.finishFrame();
  }

  /**
   * 开一层离屏：层的世界→像素映射与父级完全一致，只是按采样倍率整体缩放。
   * 效果层按 2048 封顶降采样；不透明度层保持设备分辨率。
   */
  private openLayer(
    box: { x: number; y: number; width: number; height: number },
    options: { downsample: boolean; effects: readonly RenderEffect[]; alpha: number; node: DocNode | null },
  ): void {
    const parent = this.ctx;
    const t = parent.getTransform();
    const deviceScale = Math.hypot(t.a, t.b) || 1;

    // 内容在设备像素里的外接框：父级可能带旋转，不能直接用 box 的宽高
    const project = (x: number, y: number) => ({ x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f });
    const corners = [
      project(box.x, box.y),
      project(box.x + box.width, box.y),
      project(box.x + box.width, box.y + box.height),
      project(box.x, box.y + box.height),
    ];
    // 外接框向外取整到整设备像素：位图宽高本来就是整数，框若带小数，
    // 回贴时会被拉伸 / 错半个像素，层边缘（页面投影、半透明组的轮廓）因此发糊
    const left = Math.floor(Math.min(...corners.map((p) => p.x)));
    const top = Math.floor(Math.min(...corners.map((p) => p.y)));
    const device = {
      x: left,
      y: top,
      width: Math.ceil(Math.max(...corners.map((p) => p.x))) - left,
      height: Math.ceil(Math.max(...corners.map((p) => p.y))) - top,
    };
    // 样点倍率：效果层按 2048 封顶降采样；不透明度层保持设备分辨率（降采样会糊文字）
    const scale = options.downsample
      ? effectLayerScale(device.width / deviceScale, device.height / deviceScale, deviceScale)
      : deviceScale;
    const s = scale / deviceScale;
    const width = Math.max(1, Math.round(device.width * s));
    const height = Math.max(1, Math.round(device.height * s));

    // 层内容用「父级变换减去外接框原点」绘制，因此位图里已经带着旋转
    const matrix = {
      a: t.a * s,
      b: t.b * s,
      c: t.c * s,
      d: t.d * s,
      e: (t.e - device.x) * s,
      f: (t.f - device.y) * s,
    };

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const frame: EffectFrame = {
      canvas,
      ctx: ctx ?? parent,
      scale,
      matrix,
      box,
      device,
      effects: options.effects,
      alpha: options.alpha,
      node: options.node,
      passthrough: !ctx,
      // 层像素 = (父画布像素 − device 原点) × s
      worldToDevice: (() => {
        const parentWorld = this.currentWorldToDevice();
        return parentWorld
          ? new DOMMatrix([s, 0, 0, s, -device.x * s, -device.y * s]).multiply(parentWorld)
          : null;
      })(),
    };
    if (ctx) {
      ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      ctx.lineJoin = "round";
    }
    this.frames.push(frame);
  }

  /** 当前帧的可见世界矩形（视口换算回世界坐标）。 */
  private visibleWorldRect(): Rect {
    const vp = this.viewport;
    if (!vp) return { x: 0, y: 0, width: 1, height: 1 };
    return { x: vp.x, y: vp.y, width: vp.width / vp.zoom, height: vp.height / vp.zoom };
  }

  /** 当前绘图层（最内层离屏，或主画布）的世界 → 像素矩阵。 */
  private currentWorldToDevice(): DOMMatrix | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i];
      if (!frame.passthrough) return frame.worldToDevice;
    }
    return this.worldToDevice;
  }

  /** 页面坐标 → 当前绘图层坐标（取四角反变换的外接框；旋转时略大）。 */
  private worldRectToLocal(box: Rect): Rect {
    const localToDevice = this.ctx.getTransform();
    const worldToDevice = this.currentWorldToDevice();
    if (!worldToDevice) return box;
    const m = localToDevice.inverse().multiply(worldToDevice);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [px, py] of [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x + box.width, box.y + box.height],
      [box.x, box.y + box.height],
    ] as const) {
      const x = m.a * px + m.c * py + m.e;
      const y = m.b * px + m.d * py + m.f;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  /** 结束当前层：施加效果、按组不透明度合成回父级。 */
  private finishFrame(): void {
    const frame = this.frames.pop();
    if (!frame || frame.passthrough) return;
    this.stats.layers += 1;
    const started = performance.now();
    const result = frame.effects.length > 0 ? this.composeEffects(frame) : frame.canvas;
    const parent = this.ctx;
    parent.save();
    parent.globalAlpha *= frame.alpha;
    // 层位图已经带着父级变换（含旋转）画好了，回贴必须按设备像素 1:1 摆放，
    // 不能再套一次父级变换 —— 那会把内容旋转/缩放两遍。
    parent.setTransform(1, 0, 0, 1, 0, 0);
    parent.drawImage(result, 0, 0, result.width, result.height, frame.device.x, frame.device.y, frame.device.width, frame.device.height);
    parent.restore();
    this.release(frame.canvas);
    if (result !== frame.canvas) this.release(result);
    this.stats.layerMs += performance.now() - started;
  }

  /** 依次施加效果层上记录的每一条效果（后一条基于前一条的输出）。 */
  private composeEffects(frame: EffectFrame): HTMLCanvasElement {
    let current = frame.canvas;
    for (const effect of frame.effects) {
      if (!effect.visible) continue;
      let next: HTMLCanvasElement | null = null;
      if (effect.type === "drop-shadow") next = this.composeDropShadow(current, effect, frame);
      else if (effect.type === "inner-shadow") next = this.composeInnerShadow(current, effect, frame);
      else if (effect.type === "layer-blur") next = this.composeLayerBlur(current, effect.radius, frame);
      else if (effect.type === "backdrop-blur") next = this.composeBackdropBlur(current, effect.radius, frame);
      if (next) {
        if (current !== frame.canvas) this.release(current);
        current = next;
      }
    }
    return current;
  }

  private composeDropShadow(
    src: HTMLCanvasElement,
    effect: RenderShadowEffect,
    frame: EffectFrame,
  ): HTMLCanvasElement | null {
    const w = src.width;
    const h = src.height;
    const silhouette = this.newLayer(w, h);
    const s = silhouette.getContext("2d");
    const out = this.newLayer(w, h);
    const o = out.getContext("2d");
    if (!s || !o) return null;

    // 轮廓：取合成结果的 alpha，染成阴影色
    s.drawImage(src, 0, 0);
    s.globalCompositeOperation = "source-in";
    s.fillStyle = effect.color;
    s.fillRect(0, 0, w, h);
    s.globalCompositeOperation = "source-over";

    const blurPx = Math.max(0, effect.blur) * frame.scale;
    const spread = effect.spread * frame.scale;
    const dx = effect.x * frame.scale;
    const dy = effect.y * frame.scale;
    o.filter = blurPx > 0 ? `blur(${blurPx}px)` : "none";
    o.drawImage(silhouette, dx - spread, dy - spread, w + spread * 2, h + spread * 2);
    o.filter = "none";
    o.drawImage(src, 0, 0);
    this.release(silhouette);
    return out;
  }

  private composeInnerShadow(
    src: HTMLCanvasElement,
    effect: RenderShadowEffect,
    frame: EffectFrame,
  ): HTMLCanvasElement | null {
    const w = src.width;
    const h = src.height;
    const mask = this.newLayer(w, h);
    const m = mask.getContext("2d");
    const out = this.newLayer(w, h);
    const o = out.getContext("2d");
    if (!m || !o) return null;

    const blurPx = Math.max(0, effect.blur) * frame.scale;
    const spread = effect.spread * frame.scale;
    const dx = effect.x * frame.scale;
    const dy = effect.y * frame.scale;

    // 整层铺阴影色，再用偏移轮廓挖掉内部，只在内缘留一圈
    m.fillStyle = effect.color;
    m.fillRect(0, 0, w, h);
    m.globalCompositeOperation = "destination-out";
    m.filter = blurPx > 0 ? `blur(${blurPx}px)` : "none";
    m.drawImage(src, dx - spread, dy - spread, w + spread * 2, h + spread * 2);
    m.filter = "none";
    m.globalCompositeOperation = "destination-in";
    const shape = this.shapeMask(frame, w, h);
    if (shape) m.drawImage(shape, 0, 0);
    m.globalCompositeOperation = "source-over";
    if (shape) this.release(shape);

    o.drawImage(src, 0, 0);
    o.drawImage(mask, 0, 0);
    this.release(mask);
    return out;
  }

  private composeLayerBlur(src: HTMLCanvasElement, radius: number, frame: EffectFrame): HTMLCanvasElement | null {
    const w = src.width;
    const h = src.height;
    const out = this.newLayer(w, h);
    const o = out.getContext("2d");
    if (!o) return null;
    const blurPx = Math.max(0, radius) * frame.scale;
    o.filter = blurPx > 0 ? `blur(${blurPx}px)` : "none";
    o.drawImage(src, 0, 0);
    o.filter = "none";
    // 模糊被节点自身圆角裁住（投影在形状外部，不走这里）
    const shape = this.shapeMask(frame, w, h);
    if (shape) {
      o.globalCompositeOperation = "destination-in";
      o.drawImage(shape, 0, 0);
      o.globalCompositeOperation = "source-over";
      this.release(shape);
    }
    return out;
  }

  /**
   * 背景模糊：模糊“该节点之下、父级已经画好的内容”，再裁到节点形状，垫在内容之下。
   * 取样的父级可能是主画布，也可能是外层的效果/不透明度层，因此网格与 UI 叠加层天然不参与。
   */
  private composeBackdropBlur(
    src: HTMLCanvasElement,
    radius: number,
    frame: EffectFrame,
  ): HTMLCanvasElement | null {
    const w = src.width;
    const h = src.height;
    const backdrop = this.newLayer(w, h);
    const b = backdrop.getContext("2d");
    const blurred = this.newLayer(w, h);
    const bl = blurred.getContext("2d");
    const out = this.newLayer(w, h);
    const o = out.getContext("2d");
    if (!b || !bl || !o) return null;

    // 抓取父级画布上对应的设备矩形（旋转祖先是近似）
    const source = this.ctx.canvas;
    b.drawImage(source, frame.device.x, frame.device.y, frame.device.width, frame.device.height, 0, 0, w, h);

    const blurPx = Math.max(0, radius) * frame.scale;
    bl.filter = blurPx > 0 ? `blur(${blurPx}px)` : "none";
    bl.drawImage(backdrop, 0, 0);
    bl.filter = "none";
    this.release(backdrop);

    const shape = this.shapeMask(frame, w, h);
    if (shape) {
      bl.globalCompositeOperation = "destination-in";
      bl.drawImage(shape, 0, 0);
      bl.globalCompositeOperation = "source-over";
      this.release(shape);
    }

    o.drawImage(blurred, 0, 0);
    o.drawImage(src, 0, 0);
    this.release(blurred);
    return out;
  }

  /** 节点自身轮廓（含圆角与旋转）铺满的遮罩，尺寸与效果层一致。 */
  private shapeMask(frame: EffectFrame, w: number, h: number): HTMLCanvasElement | null {
    const node = frame.node;
    if (!node) return null;
    const layer = this.newLayer(w, h);
    const g = layer.getContext("2d");
    if (!g) return null;
    const m = frame.matrix;
    g.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    if (node.rotation) {
      g.translate(node.x + node.width / 2, node.y + node.height / 2);
      g.rotate((node.rotation * Math.PI) / 180);
      g.translate(-(node.x + node.width / 2), -(node.y + node.height / 2));
    }
    this.traceShape(g, node);
    g.fillStyle = "#000";
    g.fill();
    return layer;
  }

  private newLayer(w: number, h: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    return canvas;
  }

  private release(canvas: HTMLCanvasElement): void {
    canvas.width = 0;
    canvas.height = 0;
  }

  /** 节点自身轮廓（用于把效果裁剪到形状内部）。 */
  private traceShape(g: CanvasRenderingContext2D, node: DocNode): void {
    const style = node.style;
    switch (node.type) {
      case "ellipse":
        g.beginPath();
        g.ellipse(
          node.x + node.width / 2,
          node.y + node.height / 2,
          Math.abs(node.width / 2),
          Math.abs(node.height / 2),
          0,
          0,
          Math.PI * 2,
        );
        return;
      case "polygon": {
        const points = polygonPoints(node.sides, node.width, node.height);
        g.beginPath();
        if (points.length < 3) return;
        g.moveTo(node.x + points[0].x, node.y + points[0].y);
        for (let i = 1; i < points.length; i++) g.lineTo(node.x + points[i].x, node.y + points[i].y);
        g.closePath();
        return;
      }
      case "path": {
        const vector = node.vector;
        g.beginPath();
        if (!vector || vector.anchors.length < 2) return;
        const a0 = vector.anchors[0];
        g.moveTo(node.x + a0.x, node.y + a0.y);
        const segments = vector.closed ? vector.anchors.length : vector.anchors.length - 1;
        for (let i = 0; i < segments; i++) {
          const a = vector.anchors[i];
          const b = vector.anchors[(i + 1) % vector.anchors.length];
          const curved = a.outX !== 0 || a.outY !== 0 || b.inX !== 0 || b.inY !== 0;
          if (curved) {
            g.bezierCurveTo(
              node.x + a.x + a.outX,
              node.y + a.y + a.outY,
              node.x + b.x + b.inX,
              node.y + b.y + b.inY,
              node.x + b.x,
              node.y + b.y,
            );
          } else {
            g.lineTo(node.x + b.x, node.y + b.y);
          }
        }
        if (vector.closed) g.closePath();
        return;
      }
      default:
        g.beginPath();
        this.roundedPath(g, node.x, node.y, node.width, node.height, cornerRadiusOf(style));
    }
  }

  private applyRotation(node: DocNode): void {
    if (node.rotation) {
      this.ctx.translate(node.x + node.width / 2, node.y + node.height / 2);
      this.ctx.rotate((node.rotation * Math.PI) / 180);
      this.ctx.translate(-(node.x + node.width / 2), -(node.y + node.height / 2));
    }
  }

  /** 四角独立的圆角矩形路径。 */
  private roundedPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: CornerRadius): void {
    const max = Math.max(0, Math.min(w, h) / 2);
    const tl = Math.min(radius.topLeft ?? 0, max);
    const tr = Math.min(radius.topRight ?? 0, max);
    const br = Math.min(radius.bottomRight ?? 0, max);
    const bl = Math.min(radius.bottomLeft ?? 0, max);
    g.moveTo(x + tl, y);
    g.lineTo(x + w - tr, y);
    if (tr) g.arcTo(x + w, y, x + w, y + tr, tr);
    g.lineTo(x + w, y + h - br);
    if (br) g.arcTo(x + w, y + h, x + w - br, y + h, br);
    g.lineTo(x + bl, y + h);
    if (bl) g.arcTo(x, y + h, x, y + h - bl, bl);
    g.lineTo(x, y + tl);
    if (tl) g.arcTo(x, y, x + tl, y, tl);
    g.closePath();
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
    this.roundedPath(ctx, node.x, node.y, node.width, node.height, radius);
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

  drawImage(node: DocNode, image: ResolvedImage, crop: Rect, radius: CornerRadius = ZERO_CORNER_RADIUS): void {
    if (node.width <= 0 || node.height <= 0) return;
    const ctx = this.ctx;
    const sx = Math.max(0, crop.x);
    const sy = Math.max(0, crop.y);
    const sw = Math.max(1, Math.min(crop.width, image.width - sx));
    const sh = Math.max(1, Math.min(crop.height, image.height - sy));
    ctx.save();
    // 叶子节点在父坐标系里绘制：必须先按 node.x/y 落位（与 drawRect 一致），
    // 否则图片会画到父容器原点，和选中框/命中区完全错位。
    this.applyRotation(node);
    this.roundedPath(ctx, node.x, node.y, node.width, node.height, radius);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    try {
      ctx.drawImage(image.source, sx, sy, sw, sh, node.x, node.y, node.width, node.height);
    } catch {
      // 位图已失效（被 GC/尺寸为 0）：退回占位，别让整帧失败
      this.paintImagePlaceholder(node, radius);
    }
    ctx.restore();
  }

  drawImagePlaceholder(node: DocNode, radius: CornerRadius = ZERO_CORNER_RADIUS): void {
    this.paintImagePlaceholder(node, radius);
  }

  /** 页面背景图：cover 裁切铺满、contain 完整居中、tile 按原始像素平铺 */
  drawImageInRect(image: ResolvedImage, rect: Rect, fit: "cover" | "contain" | "tile"): void {
    if (rect.width <= 0 || rect.height <= 0 || image.width <= 0 || image.height <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    try {
      if (fit === "tile") {
        // 用 pattern 平铺：1×1 的图在整页上也不会变成百万次 drawImage（每帧热路径）
        ctx.translate(rect.x, rect.y);
        const pattern = ctx.createPattern(image.source, "repeat");
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fillRect(0, 0, rect.width, rect.height);
        } else {
          // 兜底：极端环境不支持 pattern 时限制总次数，避免拖死整帧
          let draws = 0;
          for (let y = 0; y < rect.height && draws < 10_000; y += image.height) {
            for (let x = 0; x < rect.width && draws < 10_000; x += image.width, draws += 1) {
              ctx.drawImage(image.source, x, y, image.width, image.height);
            }
          }
        }
        ctx.translate(-rect.x, -rect.y);
      } else {
        const scaleX = rect.width / image.width;
        const scaleY = rect.height / image.height;
        const scale = fit === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
        const width = image.width * scale;
        const height = image.height * scale;
        ctx.drawImage(
          image.source,
          rect.x + (rect.width - width) / 2,
          rect.y + (rect.height - height) / 2,
          width,
          height,
        );
      }
    } catch {
      // 位图失效：背景图直接跳过，别让整帧失败
    }
    ctx.restore();
  }

  /** 缺失图片的占位：浅灰底 + 对角叉，和"图裂了"的通用语汇一致。 */
  private paintImagePlaceholder(node: DocNode, radius: CornerRadius): void {
    if (node.width <= 0 || node.height <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    this.applyRotation(node);
    this.roundedPath(ctx, node.x, node.y, node.width, node.height, radius);
    ctx.clip();
    ctx.fillStyle = "rgba(148, 163, 184, 0.16)";
    ctx.fillRect(node.x, node.y, node.width, node.height);
    ctx.strokeStyle = "rgba(100, 116, 139, 0.35)";
    ctx.lineWidth = Math.max(0.5, Math.min(node.width, node.height) * 0.01);
    ctx.beginPath();
    ctx.moveTo(node.x, node.y);
    ctx.lineTo(node.x + node.width, node.y + node.height);
    ctx.moveTo(node.x + node.width, node.y);
    ctx.lineTo(node.x, node.y + node.height);
    ctx.stroke();
    ctx.restore();
  }

  pushMaskLayer(bounds?: Rect): void {
    const world = intersectRect(bounds ?? this.visibleWorldRect(), this.visibleWorldRect());
    this.openLayer(this.worldRectToLocal(world), {
      downsample: false,
      effects: [],
      alpha: 1,
      node: null,
    });
  }

  popMaskLayer(drawMask: () => void, alpha = 1): void {
    const frame = this.frames[this.frames.length - 1];
    if (frame && !frame.passthrough) {
      const ctx = frame.ctx;
      ctx.save();
      // 只留蒙版形状与已画内容的交集；alpha 让"半透明蒙版"也成立
      ctx.globalCompositeOperation = "destination-in";
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      drawMask();
      ctx.restore();
    }
    this.finishFrame();
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
