import { describe, expect, it } from "vitest";
import {
  IGNORED_SVG_TAGS,
  TRANSPARENT_SVG_TAGS,
  multiplyMat,
  symbolTransform,
  viewportTransform,
  type Mat,
} from "../src/renderer/canvas/svg-import-rules";

/** 断言矩阵（浮点比较，避免 1e-17 的噪声）。 */
function expectMatrix(actual: Mat, expected: number[]): void {
  expect(actual).toHaveLength(6);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 6));
}

describe("SVG 导入规则：标签分类", () => {
  it("可执行内容与动画只丢弃，不拖垮整份文件", () => {
    for (const tag of ["script", "foreignobject", "iframe", "object", "embed", "animate", "set"]) {
      expect(IGNORED_SVG_TAGS.has(tag)).toBe(true);
    }
    expect(IGNORED_SVG_TAGS.has("rect")).toBe(false);
  });

  it("a / switch 是透明容器，内容照常解析", () => {
    expect(TRANSPARENT_SVG_TAGS.has("a")).toBe(true);
    expect(TRANSPARENT_SVG_TAGS.has("switch")).toBe(true);
    expect(TRANSPARENT_SVG_TAGS.has("g")).toBe(false);
  });
});

describe("SVG 导入规则：嵌套 svg 的视口变换", () => {
  it("没有 viewBox 时只平移", () => {
    expectMatrix(viewportTransform({ x: 12, y: 34, width: 100, height: 100 }, {}), [1, 0, 0, 1, 12, 34]);
  });

  it("viewBox 铺满或居中等比缩放（默认 xMidYMid meet）", () => {
    // 10×10 装进 100×100：放大 10 倍
    expectMatrix(viewportTransform({ x: 50, y: 50, width: 100, height: 100 }, { viewBox: [0, 0, 10, 10] }), [
      10, 0, 0, 10, 50, 50,
    ]);
    // 10×20 装进 100×100：s=5，水平余 50 → 居中偏移 25
    expectMatrix(viewportTransform({ x: 0, y: 0, width: 100, height: 100 }, { viewBox: [0, 0, 10, 20] }), [
      5, 0, 0, 5, 25, 0,
    ]);
  });

  it("preserveAspectRatio 支持 none / xMinYMin / slice", () => {
    // none：非等比拉伸
    expectMatrix(
      viewportTransform({ x: 0, y: 0, width: 100, height: 50 }, { viewBox: [0, 0, 10, 20], preserveAspectRatio: "none" }),
      [10, 0, 0, 2.5, 0, 0],
    );
    // xMinYMin meet：左上对齐，不留偏移
    expectMatrix(
      viewportTransform(
        { x: 0, y: 0, width: 100, height: 50 },
        { viewBox: [0, 0, 10, 20], preserveAspectRatio: "xMinYMin meet" },
      ),
      [2.5, 0, 0, 2.5, 0, 0],
    );
    // slice：取大比例，超出部分裁掉（居中 → 左移 50）
    expectMatrix(
      viewportTransform(
        { x: 0, y: 0, width: 100, height: 100 },
        { viewBox: [0, 0, 10, 5], preserveAspectRatio: "xMidYMid slice" },
      ),
      [20, 0, 0, 20, -50, 0],
    );
  });

  it("viewBox 带起点时先减掉起点", () => {
    expectMatrix(viewportTransform({ x: 0, y: 0, width: 20, height: 20 }, { viewBox: [10, 10, 10, 10] }), [
      2, 0, 0, 2, -20, -20,
    ]);
  });
});

describe("SVG 导入规则：use → symbol", () => {
  it("use 的 x/y 平移与宽高缩放一起生效", () => {
    expectMatrix(
      symbolTransform({ x: 10, y: 20, width: 40, height: 40 }, { viewBox: [0, 0, 10, 10] }),
      [4, 0, 0, 4, 10, 20],
    );
  });

  it("use 没给宽高时回落到 symbol 自身尺寸", () => {
    expectMatrix(
      symbolTransform({ x: 5, y: 6 }, { viewBox: [0, 0, 12, 12], width: 24, height: 24 }),
      [2, 0, 0, 2, 5, 6],
    );
  });

  it("两者都没有宽高时按 viewBox 1:1 平移", () => {
    expectMatrix(symbolTransform({ x: 3, y: 4 }, { viewBox: [0, 0, 8, 8] }), [1, 0, 0, 1, 3, 4]);
  });
});

describe("SVG 导入规则：矩阵乘法", () => {
  it("先缩放再平移", () => {
    const scale: Mat = [2, 0, 0, 2, 0, 0];
    const translate: Mat = [1, 0, 0, 1, 10, 20];
    expectMatrix(multiplyMat(translate, scale), [2, 0, 0, 2, 10, 20]);
  });
});
