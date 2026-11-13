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
  /** 本帧直接复用缓存的效果层数 */
  cacheHits: number;
  /** 本帧在缩放手势中拉伸复用旧缩放缓存的层数（>0 时宿主应在缩放停下后补画一帧清晰的） */
  staleHits: number;
}

/** 合成好的效果层（位图 1:1 对应设备像素）。 */
interface CachedEffect {
  canvas: HTMLCanvasElement;
  /** 写入时的旋转角（弧度）：缩放手势中只拉伸旋转相同的缓存 */
  angle: number;
  /** 画的时候有图片还没就绪：只作临时替身，不当精确命中 */
  incomplete: boolean;
  /** 变换的缩放 / 旋转与亚像素偏移：平移整数像素才能原样复用 */
  sig: string;
  bytes: number;
}

/** 效果层缓存总量上限（按 RGBA 字节）。 */
const EFFECT_CACHE_BUDGET = 192 * 1024 * 1024;
/** 能缓存的效果层设备尺寸上限：超过就会降采样，整块缓存会糊，退回逐帧合成可见部分 */
const EFFECT_CACHE_MAX_SIDE = 2040;
/**
 * 一帧里重画（写缓存）的时间预算：超了之后，还有旧缩放缓存可拉伸的内容先拉伸顶上、留到下一帧再画清晰。
 * 缩放停下后的"补清晰"因此分摊到多帧，不会一帧卡上近一秒。
 */
const RENDER_BUDGET_MS = 30;

function frac(v: number): string {
  return (v - Math.floor(v)).toFixed(3);
}

export class Canvas2DBackend implements RenderBackend {
  private main: CanvasRenderingContext2D;
  private frames: EffectFrame[] = [];
  /** 上一帧的离屏统计（开发态帧耗时 HUD 用；不影响绘制） */
  readonly stats: FrameStats = { layers: 0, layerMs: 0, cacheHits: 0, staleHits: 0 };
  /** 效果层缓存：跨帧保留（LRU），key 由渲染器给出 */
  private effectCache = new Map<string, CachedEffect>();
  private effectCacheBytes = 0;
  /** 与 pushEffects / popEffects 一一对应：命中缓存的、要写入缓存的、普通的 */
  private effectStack: Array<
    | { kind: "hit"; entry: CachedEffect; x: number; y: number; width: number; height: number; alpha: number }
    | { kind: "store"; key: string; sig: string; angle: number; incomplete?: boolean }
    | { kind: "plain" }
  > = [];
  private viewport: Viewport | null = null;
  /** 页面坐标 → 设备像素（由 beginFrame 的视口推导） */
  private worldToDevice: DOMMatrix | null = null;
  /**
   * 本帧缩放（dpr × zoom）与上一帧不同：正在缩放手势中。这时精确签名不可能命中，
   * 改为把旧缩放下的缓存**拉伸**回贴（短暂发虚），缩放停下后宿主补画一帧清晰的。
   */
  private scaleChanged = true;
  private lastScale = 0;
  private frameStarted = 0;

  constructor(ctx: CanvasRenderingContext2D) {
    this.main = ctx;
  }

  /** 当前绘制目标：效果层内为离屏上下文，否则为主画布。 */
  private get ctx(): CanvasRenderingContext2D {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1].ctx : this.main;
  }

  beginFrame(vp: Viewport): void {
    this.frames = [];
    this.effectStack = [];
    this.stats.layers = 0;
    this.stats.layerMs = 0;
    this.stats.cacheHits = 0;
    this.stats.staleHits = 0;
    this.viewport = vp;
    const k = vp.dpr * vp.zoom;
    this.frameStarted = performance.now();
    this.scaleChanged = k !== this.lastScale;
    this.lastScale = k;
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

  pushAlpha(alpha: number): void {
    this.ctx.save();
    this.ctx.globalAlpha *= Math.max(0, Math.min(1, alpha));
  }

  popAlpha(): void {
    this.ctx.restore();
  }

  pushEffects(node: DocNode, effects: readonly RenderEffect[], cacheKey?: string): boolean {
    const pad = effectPadding(effects);
    const full = rotatedBounds(node, pad);
    // 背景模糊取样的是"下面已经画好的内容"，平移后就变了，不能缓存
    const open = (box: Rect) => this.openLayer(box, { downsample: true, effects, alpha: 1, node });
    const cacheable = cacheKey !== undefined && !effects.some((e) => e.type === "backdrop-blur");
    const state = cacheable ? this.tryCachedLayer(cacheKey, full, open) : "uncached";
    if (state === "hit") return true;
    if (state === "uncached") {
      open(intersectRect(full, this.worldRectToLocal(this.visibleWorldRect())));
      this.effectStack.push({ kind: "plain" });
    }
    return false;
  }

  /**
   * 带缓存的开层，三种结果：
   * - `hit`：命中，记一条"回贴缓存"，调用方跳过子树；
   * - `stored`：未命中，已按 `full`（不裁视口）开层，并记下"合成完写缓存"；
   * - `uncached`：尺寸太大（整块缓存会被降采样），什么都没做，调用方按原路径（裁到视口）开层。
   */
  private tryCachedLayer(key: string, full: Rect, open: (box: Rect) => void, alpha = 1): "hit" | "stored" | "uncached" {
    const t = this.ctx.getTransform();
    const device = this.deviceRectOf(full, t);
    if (Math.max(device.width, device.height) > EFFECT_CACHE_MAX_SIDE) return "uncached";
    const sig = [t.a, t.b, t.c, t.d].map((v) => v.toFixed(6)).join(",") + `|${frac(device.x)},${frac(device.y)}`;
    const angle = Math.atan2(t.b, t.a);
    const hit = this.effectCache.get(key);
    const exact = hit && hit.sig === sig && !hit.incomplete;
    // 旧缩放下的同一内容拉伸回贴（比整块重画便宜几个数量级）：缩放手势中，或本帧重画预算已用完时。
    // 正在写缓存的层里面不能拉伸——否则模糊的内容会被当成清晰结果存进去
    const storing = this.effectStack.some((e) => e.kind === "store");
    const overBudget = performance.now() - this.frameStarted > RENDER_BUDGET_MS;
    const stale =
      !exact && hit && !storing && (this.scaleChanged || overBudget) && Math.abs(hit.angle - angle) < 1e-4;
    if (hit && (exact || stale)) {
      // LRU：挪到末尾
      this.effectCache.delete(key);
      this.effectCache.set(key, hit);
      // 同一缩放（精确命中或"未完成"的同签名替身）按整像素 1:1 贴，否则拉伸
      const sameScale = hit.sig === sig;
      const x = sameScale ? Math.floor(device.x) : device.x;
      const y = sameScale ? Math.floor(device.y) : device.y;
      const width = sameScale ? hit.canvas.width : device.width;
      const height = sameScale ? hit.canvas.height : device.height;
      this.effectStack.push({ kind: "hit", entry: hit, x, y, width, height, alpha });
      if (exact) this.stats.cacheHits += 1;
      else this.stats.staleHits += 1;
      return "hit";
    }
    // 未命中：按**整块内容**开层（不裁到视口），合成结果平移后仍然可用；缩放手势中写入的也能在后续帧拉伸复用
    open(full);
    this.effectStack.push({ kind: "store", key, sig, angle });
    return "stored";
  }

  popEffects(): void {
    const entry = this.effectStack.pop();
    if (entry?.kind === "hit") {
      const parent = this.ctx;
      parent.save();
      parent.globalAlpha *= entry.alpha;
      parent.setTransform(1, 0, 0, 1, 0, 0);
      parent.drawImage(entry.entry.canvas, entry.x, entry.y, entry.width, entry.height);
      parent.restore();
      return;
    }
    if (entry?.kind === "store") {
      this.finishFrame((result) => this.storeEffect(entry.key, entry.sig, entry.angle, entry.incomplete === true, result));
      return;
    }
    this.finishFrame();
  }

  /**
   * 整块缓存一个根节点（页面 / 主组件）：`bounds` 是世界坐标下的完整绘制范围（含投影余量），
   * `alpha` 在回贴时整体乘上（淡化页面不必再单开一层）。
   * - `hit`：命中，调用方跳过整页绘制，直接 popRootCache；
   * - `drawing`：已开层，调用方照常画整页（不要再自己处理 alpha），画完 popRootCache 写入缓存；
   * - `uncached`：太大不缓存，调用方按原路径画，**不要**调用 popRootCache。
   */
  pushRootCache(bounds: Rect, cacheKey: string, alpha: number): "hit" | "drawing" | "uncached" {
    const open = (box: Rect) => this.openLayer(box, { downsample: false, effects: [], alpha, node: null });
    const state = this.tryCachedLayer(cacheKey, this.worldRectToLocal(bounds), open, alpha);
    return state === "stored" ? "drawing" : state;
  }

  popRootCache(): void {
    this.popEffects();
  }

  /** 清空效果层缓存（换文档 / 关窗时宿主可调；不调也会按 LRU 自然淘汰）。 */
  clearEffectCache(): void {
    for (const entry of this.effectCache.values()) this.release(entry.canvas);
    this.effectCache.clear();
    this.effectCacheBytes = 0;
  }

  /** 正在写的缓存层全部记为未完成（嵌套的外层也一样：它包含了这块不完整的内容）。 */
  noteIncomplete(): void {
    for (const entry of this.effectStack) if (entry.kind === "store") entry.incomplete = true;
  }

  private storeEffect(key: string, sig: string, angle: number, incomplete: boolean, canvas: HTMLCanvasElement): void {
    const bytes = canvas.width * canvas.height * 4;
    const old = this.effectCache.get(key);
    if (old) {
      this.effectCache.delete(key);
      this.effectCacheBytes -= old.bytes;
      if (old.canvas !== canvas) this.release(old.canvas);
    }
    if (bytes > EFFECT_CACHE_BUDGET) {
      this.release(canvas);
      return;
    }
    this.effectCache.set(key, { canvas, sig, angle, incomplete, bytes });
    this.effectCacheBytes += bytes;
    for (const [k, entry] of this.effectCache) {
      if (this.effectCacheBytes <= EFFECT_CACHE_BUDGET) break;
      this.effectCache.delete(k);
      this.effectCacheBytes -= entry.bytes;
      this.release(entry.canvas);
    }
  }

  /** 当前坐标系里的矩形 → 设备像素外接框（未取整）。 */
  private deviceRectOf(box: Rect, t: DOMMatrix): Rect {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [x, y] of [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x + box.width, box.y + box.height],
      [box.x, box.y + box.height],
    ] as const) {
      xs.push(t.a * x + t.c * y + t.e);
      ys.push(t.b * x + t.d * y + t.f);
    }
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
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
  /** `keep` 给了就把合成结果交给它保管（写入效果层缓存），不释放。 */
  private finishFrame(keep?: (result: HTMLCanvasElement) => void): void {
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
    if (keep) {
      keep(result);
      if (result !== frame.canvas) this.release(frame.canvas);
    } else {
      this.release(frame.canvas);
      if (result !== frame.canvas) this.release(result);
    }
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
    // 裁切是原图像素；降采样位图按比例换到它自己的像素
    const k = image.scale ?? 1;
    ctx.save();
    // 叶子节点在父坐标系里绘制：必须先按 node.x/y 落位（与 drawRect 一致），
    // 否则图片会画到父容器原点，和选中框/命中区完全错位。
    this.applyRotation(node);
    this.roundedPath(ctx, node.x, node.y, node.width, node.height, radius);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    try {
      ctx.drawImage(image.source, sx * k, sy * k, sw * k, sh * k, node.x, node.y, node.width, node.height);
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
        // 降采样位图平铺时放大回原图尺寸，否则砖块会变小
        const k = image.scale ?? 1;
        if (pattern && k !== 1) pattern.setTransform(new DOMMatrix().scale(1 / k));
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

  pushMaskLayer(bounds?: Rect, cacheKey?: string): boolean {
    const open = (box: Rect) => this.openLayer(box, { downsample: false, effects: [], alpha: 1, node: null });
    const state = cacheKey && bounds ? this.tryCachedLayer(cacheKey, this.worldRectToLocal(bounds), open) : "uncached";
    if (state === "hit") return true;
    if (state === "uncached") {
      const world = intersectRect(bounds ?? this.visibleWorldRect(), this.visibleWorldRect());
      open(this.worldRectToLocal(world));
      this.effectStack.push({ kind: "plain" });
    }
    return false;
  }

  popMaskLayer(drawMask: () => void, alpha = 1): void {
    const entry = this.effectStack[this.effectStack.length - 1];
    if (entry?.kind === "hit") {
      // 缓存里存的是"已裁好的结果"：直接回贴，不用再画蒙版
      this.popEffects();
      return;
    }
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
    // 与效果层共用同一个栈：写缓存 / 普通收尾的逻辑完全一样
    this.popEffects();
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
