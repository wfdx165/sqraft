import { describe, expect, it } from "vitest";
import { parsePathData } from "../src/renderer/canvas/svg-path";

describe("SVG path 解析", () => {
  it("绝对直线与闭合", () => {
    const [path] = parsePathData("M0 0 L10 0 L10 10 Z")!;
    expect(path?.closed).toBe(true);
    expect(path?.anchors.map((anchor) => [anchor.x, anchor.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it("相对坐标按当前点累加", () => {
    const [path] = parsePathData("m10 10 l5 0 l0 5")!;
    expect(path?.anchors.map((anchor) => [anchor.x, anchor.y])).toEqual([
      [10, 10],
      [15, 10],
      [15, 15],
    ]);
  });

  it("三次/二次曲线写入手柄", () => {
    const [cubic] = parsePathData("M0 0 C10 0 10 10 0 10")!;
    expect(cubic?.anchors[0]?.outX).toBe(10);
    expect(cubic?.anchors[1]?.inX).toBe(10);

    const [quad] = parsePathData("M0 0 Q10 10 20 0")!;
    expect(quad?.anchors[0]?.outX).toBeCloseTo(20 / 3);
    expect(quad?.anchors[1]?.inX).toBeCloseTo(-20 / 3);
  });

  it("圆弧拆成多段，末点落在目标点", () => {
    const [path] = parsePathData("M0 0 A10 10 0 0 1 20 0")!;
    expect(path!.anchors.length).toBeGreaterThan(1);
    const last = path!.anchors[path!.anchors.length - 1]!;
    expect(last.x).toBeCloseTo(20);
    expect(last.y).toBeCloseTo(0);
  });

  it("多个 M 拆成多条子路径，不再首尾相连", () => {
    const subpaths = parsePathData("M0 0 L10 0 M20 20 L30 20")!;
    expect(subpaths).toHaveLength(2);
    expect(subpaths[0]?.anchors.map((a) => [a.x, a.y])).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(subpaths[1]?.anchors.map((a) => [a.x, a.y])).toEqual([
      [20, 20],
      [30, 20],
    ]);
    expect(subpaths.map((sub) => sub.closed)).toEqual([false, false]);
  });

  it("每个子路径各自记录闭合状态", () => {
    const subpaths = parsePathData("M0 0 L10 0 Z M20 20 L30 20")!;
    expect(subpaths.map((sub) => sub.closed)).toEqual([true, false]);
  });

  it("Z 之后继续绘制会从闭合点开始新子路径", () => {
    const subpaths = parsePathData("M0 0 L10 0 Z L0 10")!;
    expect(subpaths).toHaveLength(2);
    expect(subpaths[1]?.anchors.map((a) => [a.x, a.y])).toEqual([
      [0, 0],
      [0, 10],
    ]);
  });

  it("空字符串返回 null", () => {
    expect(parsePathData("")).toBeNull();
  });
});
