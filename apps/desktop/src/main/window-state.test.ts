import { describe, expect, it } from "vitest";
import { restoreBounds } from "./window-state";

const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];
const twoScreens = [...displays, { x: 1920, y: 0, width: 1512, height: 982 }];

describe("窗口位置恢复", () => {
  it("没有记录时给默认尺寸", () => {
    expect(restoreBounds(undefined, displays)).toEqual({ width: 1440, height: 900, maximized: false });
  });

  it("位置在屏幕内时原样恢复", () => {
    const saved = { x: 100, y: 80, width: 1200, height: 800, maximized: true };
    expect(restoreBounds(saved, displays)).toEqual(saved);
  });

  it("位置完全落在屏幕外时丢掉坐标", () => {
    const saved = { x: 5000, y: 5000, width: 1200, height: 800 };
    expect(restoreBounds(saved, displays)).toEqual({ width: 1200, height: 800, maximized: false });
  });

  it("窗口整体停在屏幕左侧外时也丢掉坐标（不是只有正方向才算屏幕外）", () => {
    // 右边缘在 -50：整块窗口都在屏幕左边，恢复出来就是看不见
    const saved = { x: -1250, y: 100, width: 1200, height: 800 };
    expect(restoreBounds(saved, displays)).toEqual({ width: 1200, height: 800, maximized: false });
  });

  it("纵向偏出屏幕同样丢掉坐标", () => {
    const saved = { x: 100, y: -1000, width: 1200, height: 800 };
    expect(restoreBounds(saved, displays)).toEqual({ width: 1200, height: 800, maximized: false });
  });

  it("只露出很窄一条时丢掉坐标（少于 80px 等于拿不回来）", () => {
    const saved = { x: -1160, y: 100, width: 1200, height: 800 }; // 露出 40px
    expect(restoreBounds(saved, displays)).toEqual({ width: 1200, height: 800, maximized: false });
  });

  it("露出足够多时保留坐标", () => {
    const saved = { x: -1100, y: 100, width: 1200, height: 800 }; // 露出 100px
    expect(restoreBounds(saved, displays)).toEqual({ ...saved, maximized: false });
  });

  it("拖到副屏后仍然认得那个位置", () => {
    const saved = { x: 1930, y: 60, width: 1200, height: 800 };
    expect(restoreBounds(saved, twoScreens)).toEqual({ ...saved, maximized: false });
  });

  it("过小的窗口被抬到最小尺寸", () => {
    expect(restoreBounds({ width: 200, height: 100 }, displays)).toMatchObject({ width: 960, height: 600 });
  });
});
