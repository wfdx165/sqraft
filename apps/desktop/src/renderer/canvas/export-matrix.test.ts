import { describe, expect, it } from "vitest";
import { matrixPlan } from "./export-matrix";

describe("多倍率导出的输出计划", () => {
  it("默认 1× + 2×，不带 SVG", () => {
    expect(matrixPlan({ scales: [1, 2], includeSvg: false })).toEqual([
      { format: "png", scale: 1 },
      { format: "png", scale: 2 },
    ]);
  });

  it("去重、只留 1/2/4、升序", () => {
    expect(matrixPlan({ scales: [4, 2, 2, 3, 0], includeSvg: false })).toEqual([
      { format: "png", scale: 2 },
      { format: "png", scale: 4 },
    ]);
  });

  it("勾选 SVG 时追加一份，不带倍率", () => {
    const plan = matrixPlan({ scales: [1], includeSvg: true });
    expect(plan).toEqual([
      { format: "png", scale: 1 },
      { format: "svg", scale: 1 },
    ]);
  });

  it("全部倍率非法且不带 SVG 时为空（调用方负责提示）", () => {
    expect(matrixPlan({ scales: [3, 5], includeSvg: false })).toEqual([]);
  });
});
