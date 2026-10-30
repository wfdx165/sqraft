/** 随缩放自适应的点阵背景（屏幕空间绘制）。 */
import type { Viewport } from "@sqraft/render";

export function drawGrid(g: CanvasRenderingContext2D, v: Viewport): void {
  let world = 24;
  while (world * v.zoom < 14) world *= 2;
  const step = world * v.zoom;
  const offX = -((v.x * v.zoom) % step + step) % step;
  const offY = -((v.y * v.zoom) % step + step) % step;
  g.save();
  g.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  g.fillStyle = "rgba(15, 23, 42, 0.10)";
  for (let x = offX; x < v.width; x += step) {
    for (let y = offY; y < v.height; y += step) {
      g.fillRect(x, y, 1.3, 1.3);
    }
  }
  g.restore();
}
