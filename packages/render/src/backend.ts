/**
 * RenderBackend：核心与渲染之间的唯一接口（ADR-0002）。
 * 未来 WebGL2 后端实现同一接口即可替换，文档模型零改动。
 */

import type { BlurEffect, CornerRadius, DocNode, DocState, Rect, ShadowEffect, VectorPath } from "@sqraft/core";

/** 已经解析成 CSS 颜色的阴影效果：后端不解析 Token。 */
export type RenderShadowEffect = Omit<ShadowEffect, "color"> & { color: string };
/** 交给后端的可绘制效果（颜色已解析、visible 已过滤）。 */
export type RenderEffect = RenderShadowEffect | BlurEffect;

export interface Viewport {
  /** 视口左上角在世界坐标中的位置 */
  x: number;
  y: number;
  zoom: number;
  /** CSS 像素尺寸 */
  width: number;
  height: number;
  dpr: number;
}

export interface RenderContext {
  doc: DocState;
  resolveColor(tokenOrValue: { token?: string; value?: string } | null | undefined): string | undefined;
  /**
   * 按 assetId 取已解码的图片；没解码好或缺资源时返回 null（渲染占位）。
   * `want` 是屏幕上需要的分辨率占原图的比例（0–1），宿主可据此返回降采样的位图；缺省 = 要原图。
   */
  resolveImage(assetId: string, want?: number): ResolvedImage | null;
  /** 设备像素 / 文档单位；缺省表示不降采样（导出）。 */
  pixelRatio?: number;
  /**
   * 效果层缓存：`epoch` 随文档 / 异步资源变化，`volatile` 是本帧带预览或正在编辑的节点及其祖先（不缓存）。
   * 缺省 = 不缓存（导出）。
   */
  effectCache?: { epoch: string; volatile: ReadonlySet<string> };
  /** 这张嵌入图是否还在解码（画的是占位或临时的粗级别）。缺省视为已就绪。 */
  imagePending?(assetId: string): boolean;
  /** 按远程 URL 取已解码的图片；未抓取/未解码时返回 null（渲染占位） */
  resolveLinkedImage(url: string): ResolvedImage | null;
}

/** 已解码的图片：`source` 可直接交给 drawImage，宽高是**原图**像素。 */
export interface ResolvedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  /**
   * `source` 相对原图的缩放（降采样解码时 < 1，缺省 1）。裁切等坐标一律按原图像素给，
   * 后端取样时乘上它——上层不需要知道拿到的是哪一级位图。
   */
  scale?: number;
}

export interface RenderBackend {
  beginFrame(vp: Viewport): void;
  /** 压入容器坐标与旋转（绕容器中心），popTransform 必须配对 */
  pushTransform(x: number, y: number, rotation?: number, width?: number, height?: number): void;
  popTransform(): void;
  /** 压入裁剪区域（当前坐标系），popClip 必须配对 */
  pushClip(x: number, y: number, width: number, height: number, radius: CornerRadius): void;
  popClip(): void;
  /**
   * 压入组不透明度层：其后绘制的子树先进入离屏，popOpacity 时整体乘一次 alpha 再合回。
   * `bounds` 是子树在页面坐标系里的包围盒（缺省退化为当前视口），后端会与视口求交，
   * 因此层尺寸恒不超过一屏。pushOpacity / popOpacity 必须配对。
   */
  pushOpacity(alpha: number, bounds?: Rect): void;
  popOpacity(): void;
  /**
   * 不开离屏、直接把后续绘制乘上 alpha。只用于「整棵子树只有一次绘制操作」的节点——
   * 那时组隔离与逐操作乘 alpha 结果完全相同，却省掉一张离屏层。pushAlpha / popAlpha 必须配对。
   */
  pushAlpha(alpha: number): void;
  popAlpha(): void;
  /**
   * 开启效果层：其后绘制的整棵子树先进入离屏缓冲，popEffects 时按顺序施加效果
   * 再合成回当前上下文。pushEffects / popEffects 必须配对，可嵌套。
   */
  /**
   * `cacheKey` 给了就允许复用上一帧合成好的结果（见 ADR-0033）：返回 true 表示命中缓存，
   * 调用方**跳过整棵子树的绘制**，直接 popEffects。key 必须随子树内容变化而变化。
   */
  pushEffects(node: DocNode, effects: readonly RenderEffect[], cacheKey?: string): boolean | void;
  popEffects(): void;
  drawRect(node: DocNode, fill?: string, stroke?: string, strokeWidth?: number, radius?: CornerRadius, shadow?: boolean): void;
  drawEllipse(node: DocNode, fill?: string, stroke?: string, strokeWidth?: number): void;
  drawLine(node: DocNode, stroke?: string, strokeWidth?: number): void;
  /** 矢量路径：闭合时 closePath；fill/stroke 为空则跳过对应绘制 */
  drawPath(node: DocNode, vector: VectorPath, fill?: string, stroke?: string, strokeWidth?: number): void;
  /** 参数化多边形：points 为节点本地坐标，闭合描边 */
  drawPolygon(node: DocNode, points: ReadonlyArray<{ x: number; y: number }>, fill?: string, stroke?: string, strokeWidth?: number): void;
  drawText(node: DocNode, fill?: string, stroke?: string): void;
  /** 图片：`crop` 是原图像素坐标下的可见区域，绘制到节点框内 */
  drawImage(node: DocNode, image: ResolvedImage, crop: Rect, radius?: CornerRadius): void;
  /** 图片缺失占位（资源没随文件带过来时） */
  drawImagePlaceholder(node: DocNode, radius?: CornerRadius): void;
  /** 把整张图按 fit 画进给定矩形（页面背景图用），超出矩形的部分裁掉 */
  drawImageInRect(image: ResolvedImage, rect: Rect, fit: "cover" | "contain" | "tile"): void;
  /**
   * 蒙版层：其后的绘制先进入离屏，`popMaskLayer` 时用回调画出的形状 alpha
   * 裁掉多余部分再合成回来。push/pop 必须配对。
   * `alpha` 是蒙版节点自身的不透明度（半透明蒙版 = 半透明的裁切）。
   */
  /**
   * 整块缓存一个根节点（页面 / 主组件）的绘制结果，见 Canvas2DBackend.pushRootCache。可选：不实现就不缓存。
   */
  pushRootCache?(bounds: Rect, cacheKey: string, alpha: number): "hit" | "drawing" | "uncached";
  /**
   * 当前画的内容不是最终结果（图片还在解码 / 链接图还没取到）：正在写的缓存层都记为未完成，
   * 之后只作临时替身，不当精确命中。可选。
   */
  noteIncomplete?(): void;
  popRootCache?(): void;
  /** `cacheKey` 语义同 pushEffects：返回 true 表示命中缓存，调用方跳过目标子树并直接 popMaskLayer。 */
  pushMaskLayer(bounds?: Rect, cacheKey?: string): boolean | void;
  popMaskLayer(drawMask: () => void, alpha?: number): void;
  endFrame(): void;
}

export function screenToWorld(vp: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: vp.x + sx / vp.zoom, y: vp.y + sy / vp.zoom };
}

export function worldToScreen(vp: Viewport, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - vp.x) * vp.zoom, y: (wy - vp.y) * vp.zoom };
}
