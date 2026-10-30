/**
 * 页面在视口里的适配取景（纯函数，便于单测）。
 *
 * 规则与缩放菜单的「适配」完全一致：留出 `padding` 的四边空隙，
 * 取能放下整页的较小缩放，夹在 [0.02, 1]（不为了小页面放大到 100% 以上）。
 */
export interface FitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FitViewport {
  width: number;
  height: number;
}

export interface FitResult {
  /** 视口左上角对应的世界坐标 */
  x: number;
  y: number;
  zoom: number;
}

export const MIN_FIT_ZOOM = 0.02;

export function pageFitViewport(rect: FitRect, viewport: FitViewport, padding = 80): FitResult {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const zoom = Math.min(
    Math.max((viewport.width - padding * 2) / width, MIN_FIT_ZOOM),
    Math.max((viewport.height - padding * 2) / height, MIN_FIT_ZOOM),
    1,
  );
  return {
    x: rect.x + width / 2 - viewport.width / (2 * zoom),
    y: rect.y + height / 2 - viewport.height / (2 * zoom),
    zoom,
  };
}
