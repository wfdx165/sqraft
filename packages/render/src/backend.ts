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
  /** 按 assetId 取已解码的图片；没解码好或缺资源时返回 null（渲染占位） */
  resolveImage(assetId: string): ResolvedImage | null;
}

/** 已解码的图片：`source` 可直接交给 drawImage，宽高是原图像素。 */
export interface ResolvedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
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
   * 开启效果层：其后绘制的整棵子树先进入离屏缓冲，popEffects 时按顺序施加效果
   * 再合成回当前上下文。pushEffects / popEffects 必须配对，可嵌套。
   */
  pushEffects(node: DocNode, effects: readonly RenderEffect[]): void;
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
  pushMaskLayer(bounds?: Rect): void;
  popMaskLayer(drawMask: () => void, alpha?: number): void;
  endFrame(): void;
}

export function screenToWorld(vp: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: vp.x + sx / vp.zoom, y: vp.y + sy / vp.zoom };
}

export function worldToScreen(vp: Viewport, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - vp.x) * vp.zoom, y: (wy - vp.y) * vp.zoom };
}
