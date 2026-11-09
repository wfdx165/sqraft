import { describe, expect, it } from "vitest";
import { clampCrop, panCrop, scaleCrop } from "./image-crop";

const natural = { width: 1000, height: 500 };
const box = { width: 500, height: 250 };

describe("裁切夹取", () => {
  it("宽高不超过原图，位置不越界", () => {
    expect(clampCrop({ x: 900, y: 400, width: 2000, height: 2000 }, natural)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 500,
    });
  });

  it("尺寸至少 1px", () => {
    expect(clampCrop({ x: 0, y: 0, width: 0, height: -5 }, natural)).toMatchObject({ width: 1, height: 1 });
  });
});

describe("框内拖动", () => {
  it("往右下拖，看到的是图片更左上的一部分", () => {
    const crop = { x: 100, y: 50, width: 400, height: 200 };
    // 框 500×250，crop 400×200：1px 框位移 = 0.8px 图片位移
    expect(panCrop(crop, natural, box, 50, 25)).toEqual({ x: 60, y: 30, width: 400, height: 200 });
  });

  it("拖到边界外会被夹住", () => {
    const crop = { x: 0, y: 0, width: 400, height: 200 };
    expect(panCrop(crop, natural, box, 9999, 9999)).toEqual({ x: 0, y: 0, width: 400, height: 200 });
  });
});

describe("拖角缩放", () => {
  const crop = { x: 200, y: 100, width: 400, height: 200 };

  it("收小右下角：锚点在左上，范围变小", () => {
    const next = scaleCrop(crop, natural, box, { width: 250, height: 125 }, "se");
    expect(next).toEqual({ x: 200, y: 100, width: 200, height: 100 });
  });

  it("收小左上角：锚点在右下，起点后移", () => {
    const next = scaleCrop(crop, natural, box, { width: 250, height: 125 }, "nw");
    expect(next).toEqual({ x: 400, y: 200, width: 200, height: 100 });
  });

  it("放大不会超出原图", () => {
    const next = scaleCrop(crop, natural, box, { width: 5000, height: 5000 }, "se");
    expect(next.width).toBe(natural.width - crop.x);
    expect(next.height).toBe(natural.height - crop.y);
  });
});
