import { describe, expect, it } from "vitest";
import type { Viewport } from "@sqraft/render";
import { targetVisible } from "./prototype-links";

const vp: Viewport = { x: 0, y: 0, zoom: 0.5, width: 800, height: 600, dpr: 2 };

describe("原型链接：目标页可见性", () => {
  it("视口内的页面画连线，视口外的退化成胶囊", () => {
    // 世界可视范围 = 1600 × 1200
    expect(targetVisible(vp, { x: 100, y: 100, width: 400, height: 300 })).toBe(true);
    expect(targetVisible(vp, { x: 2000, y: 0, width: 400, height: 300 })).toBe(false);
    // 跨边界也算可见
    expect(targetVisible(vp, { x: -200, y: -200, width: 400, height: 400 })).toBe(true);
  });

  it("缩放不影响判断口径（宽高按 zoom 折算世界尺寸）", () => {
    const zoomed: Viewport = { ...vp, zoom: 2 };
    // 放大到 2×：世界可视范围只剩 400 × 300
    expect(targetVisible(zoomed, { x: 410, y: 0, width: 100, height: 100 })).toBe(false);
    expect(targetVisible(zoomed, { x: 350, y: 0, width: 100, height: 100 })).toBe(true);
  });
});
