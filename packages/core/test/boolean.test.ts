import { describe, expect, it } from "vitest";
import { booleanBounds, booleanContours, type BooleanOp } from "../src/boolean";
import { makeAnchor, pathFromAnchors, pointInVector, type VectorContour } from "../src/vector";

const K = 0.5522847498;

/** 用四段三次贝塞尔近似一个圆。 */
function circle(cx: number, cy: number, r: number): VectorContour {
  const k = K * r;
  return {
    closed: true,
    anchors: [
      makeAnchor(cx - r, cy, { inX: 0, inY: k, outX: 0, outY: -k }),
      makeAnchor(cx, cy - r, { inX: -k, inY: 0, outX: k, outY: 0 }),
      makeAnchor(cx + r, cy, { inX: 0, inY: -k, outX: 0, outY: k }),
      makeAnchor(cx, cy + r, { inX: k, inY: 0, outX: -k, outY: 0 }),
    ],
  };
}

function box(x: number, y: number, w: number, h: number): VectorContour {
  return pathFromAnchors(
    [makeAnchor(x, y), makeAnchor(x + w, y), makeAnchor(x + w, y + h), makeAnchor(x, y + h)],
    true,
  ).contours[0];
}

function shape(contours: readonly VectorContour[]) {
  return { contours: [...contours], fillRule: "evenodd" as const };
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function run(op: BooleanOp, operands: VectorContour[][], options?: { maxSegments?: number; totalMaxSegments?: number }) {
  return booleanContours(operands, op, options);
}

describe("布尔几何内核", () => {
  it("两圆并集：一个区域、包围盒覆盖两者", () => {
    const result = run("union", [[circle(50, 50, 50)], [circle(100, 50, 50)]]);
    expect(result).toHaveLength(1);
    const bounds = booleanBounds(result);
    expect(bounds.x).toBeCloseTo(0, 0);
    expect(bounds.y).toBeCloseTo(0, 0);
    expect(bounds.width).toBeCloseTo(150, 0);
    expect(bounds.height).toBeCloseTo(100, 0);
    const filled = shape(result);
    expect(pointInVector(filled, 50, 50)).toBe(true);
    expect(pointInVector(filled, 100, 50)).toBe(true);
    expect(pointInVector(filled, 75, 20)).toBe(true);
  });

  it("矩形减圆：圆完全在内部时留下洞", () => {
    const result = run("subtract", [[box(0, 0, 100, 100)], [circle(50, 50, 25)]]);
    expect(result).toHaveLength(2);
    const filled = shape(result);
    expect(pointInVector(filled, 50, 50)).toBe(false);
    expect(pointInVector(filled, 10, 10)).toBe(true);
    expect(booleanBounds(result).width).toBeCloseTo(100, 0);
  });

  it("同心圆求差：环内有点、圆心没点", () => {
    const result = run("subtract", [[circle(50, 50, 50)], [circle(50, 50, 20)]]);
    expect(result).toHaveLength(2);
    const filled = shape(result);
    expect(pointInVector(filled, 50, 50)).toBe(false);
    expect(pointInVector(filled, 50, 80)).toBe(true);
    expect(pointInVector(filled, 50, 95)).toBe(true);
  });

  it("相切的两圆并集不抛异常，结果仍是有限区域", () => {
    const result = run("union", [[circle(20, 20, 20)], [circle(60, 20, 20)]]);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const bounds = booleanBounds(result);
    expect(bounds.width).toBeCloseTo(80, 0);
    expect(bounds.height).toBeCloseTo(40, 0);
    expect(pointInVector(shape(result), 40, 20)).toBe(true);
  });

  it("完全包含：并集等于大圆，锚点不会失控", () => {
    const result = run("union", [[circle(50, 50, 50)], [circle(50, 50, 10)]]);
    expect(result).toHaveLength(1);
    expect(result[0].anchors.length).toBeLessThan(80);
    expect(booleanBounds(result).width).toBeCloseTo(100, 0);
  });

  it("intersect 不相交时拒绝", () => {
    expect(errorCode(() => run("intersect", [[box(0, 0, 20, 20)], [box(100, 0, 20, 20)]]))).toBe(
      "core.boolean.noOverlap",
    );
  });

  it("exclude 去掉重叠部分", () => {
    const result = run("exclude", [[box(0, 0, 20, 20)], [box(10, 10, 20, 20)]]);
    const filled = shape(result);
    expect(pointInVector(filled, 5, 5)).toBe(true);
    expect(pointInVector(filled, 15, 15)).toBe(false);
    expect(pointInVector(filled, 25, 25)).toBe(true);
  });

  it("退化轮廓：共线三点被拒绝", () => {
    const collinear = pathFromAnchors([makeAnchor(0, 0), makeAnchor(10, 10), makeAnchor(20, 20)], true).contours[0];
    expect(errorCode(() => run("union", [[collinear], [box(0, 0, 10, 10)]]))).toBe(
      "core.boolean.invalidGeometry",
    );
  });

  it("开放轮廓拒绝", () => {
    const open = pathFromAnchors([makeAnchor(0, 0), makeAnchor(10, 0), makeAnchor(10, 10)]).contours[0];
    expect(errorCode(() => run("union", [[open], [box(0, 0, 10, 10)]]))).toBe("core.boolean.openContour");
  });

  it("超过段数上限时拒绝（可用 options 收紧）", () => {
    expect(errorCode(() => run("union", [[circle(0, 0, 100)], [circle(40, 0, 100)]], { maxSegments: 4 }))).toBe(
      "core.boolean.tooComplex",
    );
  });

  it("少于两个操作数拒绝", () => {
    expect(errorCode(() => run("union", [[box(0, 0, 10, 10)]]))).toBe("core.boolean.single");
  });

  it("圆参与运算时回拟合为曲线，不是把每个展平点都留成锚点", () => {
    const result = run("subtract", [[box(0, 0, 200, 200)], [circle(100, 100, 30)]]);
    expect(result).toHaveLength(2);
    const hole = result[1];
    expect(hole.anchors.length).toBeLessThanOrEqual(12);
    expect(hole.anchors.some((anchor) => anchor.inX !== 0 || anchor.outX !== 0 || anchor.inY !== 0 || anchor.outY !== 0)).toBe(
      true,
    );
    // 节点框贴合曲线：圆半径 30，不能因为控制柄而明显变大
    const bounds = booleanBounds([hole]);
    expect(bounds.width).toBeCloseTo(60, 0);
    expect(bounds.height).toBeCloseTo(60, 0);
  });

  it("差集结果为空时报 emptyResult，不归为几何退化", () => {
    // 大矩形把被减数完全盖住：合法的空结果，应给专门错误码
    expect(errorCode(() => run("subtract", [[box(0, 0, 20, 20)], [box(-10, -10, 50, 50)]]))).toBe(
      "core.boolean.emptyResult",
    );
  });

  it("所有操作数合计段数超限时拒绝", () => {
    expect(
      errorCode(() =>
        run("union", [[circle(0, 0, 40)], [circle(40, 0, 40)], [circle(80, 0, 40)]], { totalMaxSegments: 40 }),
      ),
    ).toBe("core.boolean.tooComplex");
  });

  it("结果确定：同一输入两次输出完全一致", () => {
    const a = run("union", [[circle(50, 50, 40)], [circle(90, 50, 40)]]);
    const b = run("union", [[circle(50, 50, 40)], [circle(90, 50, 40)]]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
