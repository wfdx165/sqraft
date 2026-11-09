import { describe, expect, it } from "vitest";
import { pageFitViewport } from "./viewport-fit";

/** 把世界坐标里的点换算到屏幕坐标（与画布同一套公式）。 */
function toScreen(rect: { x: number; y: number }, fit: { x: number; y: number; zoom: number }) {
  return { x: (rect.x - fit.x) * fit.zoom, y: (rect.y - fit.y) * fit.zoom };
}

describe("页面适配取景", () => {
  const viewport = { width: 1200, height: 800 };
  const page = { x: 0, y: 0, width: 1280, height: 800 };

  it("整页居中，四边留 padding", () => {
    const fit = pageFitViewport(page, viewport, 80);
    const left = toScreen({ x: page.x, y: page.y }, fit);
    const right = toScreen({ x: page.x + page.width, y: page.y + page.height }, fit);
    // 高度先到限：(800 - 160) / 800 = 0.8
    expect(fit.zoom).toBeCloseTo(0.8, 6);
    // 水平方向没到 padding 下限：两边各留 (1200 - 1280*0.8)/2 = 88
    expect(left.x).toBeCloseTo(88, 6);
    expect(right.x).toBeCloseTo(1112, 6);
    // 垂直方向正好上下各留 80
    expect(left.y).toBeCloseTo(80, 6);
    expect(right.y).toBeCloseTo(720, 6);
  });

  it("小页面不放大超过 100%", () => {
    const fit = pageFitViewport({ x: 0, y: 0, width: 200, height: 100 }, viewport, 80);
    expect(fit.zoom).toBe(1);
    // 100% 下居中：x = 100 - 600 = -500
    expect(fit.x).toBeCloseTo(-500, 6);
    expect(fit.y).toBeCloseTo(-350, 6);
  });

  it("巨大的页面夹到最小缩放 0.02", () => {
    const fit = pageFitViewport({ x: 0, y: 0, width: 200_000, height: 100_000 }, viewport, 80);
    expect(fit.zoom).toBe(0.02);
  });

  it("页面偏移时按页面中心取景", () => {
    const fit = pageFitViewport({ x: 4000, y: 2000, width: 1000, height: 600 }, { width: 1000, height: 800 }, 80);
    const center = toScreen({ x: 4500, y: 2300 }, fit);
    expect(center.x).toBeCloseTo(500, 6);
    expect(center.y).toBeCloseTo(400, 6);
  });

  it("零尺寸不产生除零/NaN", () => {
    const fit = pageFitViewport({ x: 0, y: 0, width: 0, height: 0 }, viewport, 80);
    expect(Number.isFinite(fit.x)).toBe(true);
    expect(Number.isFinite(fit.y)).toBe(true);
    expect(Number.isFinite(fit.zoom)).toBe(true);
    expect(fit.zoom).toBe(1);
  });
});
