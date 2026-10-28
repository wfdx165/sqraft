/**
 * RenderBackend：核心与渲染之间的唯一接口（ADR-0002）。
 * 未来 WebGL2 后端实现同一接口即可替换，文档模型零改动。
 */

import type { DocNode, DocState } from "@sqraft/core";

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
}

export interface RenderBackend {
  beginFrame(vp: Viewport): void;
  drawRect(node: DocNode, fill?: string, stroke?: string, strokeWidth?: number, radius?: number, shadow?: boolean): void;
  drawEllipse(node: DocNode, fill?: string, stroke?: string, strokeWidth?: number): void;
  drawLine(node: DocNode, stroke?: string, strokeWidth?: number): void;
  drawText(node: DocNode, fill?: string): void;
  drawFrameOutline(node: DocNode): void;
  endFrame(): void;
}

export function screenToWorld(vp: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: vp.x + sx / vp.zoom, y: vp.y + sy / vp.zoom };
}

export function worldToScreen(vp: Viewport, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - vp.x) * vp.zoom, y: (wy - vp.y) * vp.zoom };
}
