import { describe, expect, it } from "vitest";
import { ROTATE_ZONE_PX, rotateZoneAt } from "./rotate-drag";

/** 缩放手柄的命中半径（CanvasView 的 HANDLE_HIT_PX 与之一致） */
const HANDLE = 7;

/** 100,100 → 300,300 的轴对齐四边形，顺时针四角 */
const square = [
  { x: 100, y: 100 },
  { x: 300, y: 100 },
  { x: 300, y: 300 },
  { x: 100, y: 300 },
];

describe("四角外侧的旋转热区", () => {
  it("四个角的外侧都命中", () => {
    expect(rotateZoneAt(square, 90, 90, HANDLE)).toBe(true); // 左上
    expect(rotateZoneAt(square, 310, 90, HANDLE)).toBe(true); // 右上
    expect(rotateZoneAt(square, 310, 310, HANDLE)).toBe(true); // 右下
    expect(rotateZoneAt(square, 90, 310, HANDLE)).toBe(true); // 左下
  });

  it("手柄本体与框内不命中：手柄归缩放，框内靠近角的地方留给拖动", () => {
    expect(rotateZoneAt(square, 103, 103, HANDLE)).toBe(false); // 手柄正中
    expect(rotateZoneAt(square, 100, 100, HANDLE)).toBe(false); // 角点本身
    expect(rotateZoneAt(square, 110, 110, HANDLE)).toBe(false); // 框内斜向内
    expect(rotateZoneAt(square, 95, 110, HANDLE)).toBe(false); // 只有横向在外，够不上外侧象限
    expect(rotateZoneAt(square, 110, 95, HANDLE)).toBe(false); // 只有纵向在外
  });

  it("外侧带是 12px：贴着手柄边缘命中，再远一点就不命中", () => {
    const near = HANDLE + 1;
    const edge = HANDLE + ROTATE_ZONE_PX - 0.5;
    const far = HANDLE + ROTATE_ZONE_PX + 1;
    expect(rotateZoneAt(square, 100 - near, 100 - near, HANDLE)).toBe(true);
    expect(rotateZoneAt(square, 100 - edge, 100 - edge, HANDLE)).toBe(true);
    expect(rotateZoneAt(square, 100 - far, 100 - far, HANDLE)).toBe(false);
  });

  it("边的中点外侧不算：只有四角有旋转热区", () => {
    expect(rotateZoneAt(square, 190, 95, HANDLE)).toBe(false);
    expect(rotateZoneAt(square, 305, 200, HANDLE)).toBe(false);
  });

  it("旋转 45° 后的四边形同样按角判定", () => {
    const diamond = [
      { x: 200, y: 100 },
      { x: 300, y: 200 },
      { x: 200, y: 300 },
      { x: 100, y: 200 },
    ];
    expect(rotateZoneAt(diamond, 191, 91, HANDLE)).toBe(true); // 上角外侧
    expect(rotateZoneAt(diamond, 309, 209, HANDLE)).toBe(true); // 右角外侧
    expect(rotateZoneAt(diamond, 200, 100, HANDLE)).toBe(false); // 角点本身
    expect(rotateZoneAt(diamond, 200, 85, HANDLE)).toBe(true); // 角外侧（框外 15px）
    expect(rotateZoneAt(diamond, 200, 105, HANDLE)).toBe(false); // 框内靠近角：留给拖动
    expect(rotateZoneAt(diamond, 200, 70, HANDLE)).toBe(false); // 太远
  });

  it("空选区与非法带宽直接不命中", () => {
    expect(rotateZoneAt([], 0, 0, HANDLE)).toBe(false);
    expect(rotateZoneAt(square, 90, 90, HANDLE, 0)).toBe(false);
  });
});
