import { describe, expect, it } from "vitest";
import {
  createDocWithPage,
  createNode,
  worldQuad,
  type DocState,
  type GradientValue,
  type TokenEntry,
} from "@sqraft/core";
import {
  dragGradientHandle,
  gradientFrameOf,
  gradientHandles,
  gradientTargetOf,
  hitGradientHandle,
  hitGradientLine,
  insertStopAt,
  removeStopAt,
  setStopOffset,
  unitToWorld,
  worldToUnit,
  type GradientFrame,
} from "../src/renderer/canvas/gradient-handles";

const linear: GradientValue = {
  type: "linear",
  from: { x: 0, y: 0.5 },
  to: { x: 1, y: 0.5 },
  stops: [
    { offset: 0, color: { value: "#000000" } },
    { offset: 1, color: { value: "#ffffff" } },
  ],
};

const RECT = { x: 100, y: 100, width: 200, height: 100 };

/** 与 worldQuad 同一规则：绕包围盒中心旋转，返回 TL/TR/BR/BL。 */
function quadOf(rect = RECT, rotation = 0): GradientFrame["quad"] {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotate = (x: number, y: number) => ({
    x: cx + (x - cx) * cos - (y - cy) * sin,
    y: cy + (x - cx) * sin + (y - cy) * cos,
  });
  return [
    rotate(rect.x, rect.y),
    rotate(rect.x + rect.width, rect.y),
    rotate(rect.x + rect.width, rect.y + rect.height),
    rotate(rect.x, rect.y + rect.height),
  ];
}

function frame(patch: Partial<GradientFrame> = {}): GradientFrame {
  return {
    nodeId: "n1",
    kind: "fill",
    value: linear,
    quad: quadOf(),
    ...patch,
  };
}

describe("渐变手柄：目标判定", () => {
  it("填充是字面量渐变时选填充", () => {
    const node = createNode("rect", { style: { fill: linear } });
    expect(gradientTargetOf(node, {})?.kind).toBe("fill");
  });

  it("填充不是渐变时回落到描边", () => {
    const node = createNode("rect", { style: { fill: { value: "#000000" }, stroke: linear } });
    expect(gradientTargetOf(node, {})?.kind).toBe("stroke");
  });

  it("引用渐变 Token 时取 Token 里的值", () => {
    const tokens: Record<string, TokenEntry> = { "gradient/brand": { type: "gradient", value: linear } };
    const node = createNode("rect", { style: { fill: { token: "gradient/brand" } } });
    const target = gradientTargetOf(node, tokens);
    expect(target?.kind).toBe("fill");
    expect(target?.value).toBe(linear);
  });

  it("没有渐变或 Token 失效时返回 null", () => {
    expect(gradientTargetOf(createNode("rect", { style: { fill: { value: "#fff" } } }), {})).toBeNull();
    const broken = createNode("rect", { style: { fill: { token: "gradient/broken" } } });
    expect(gradientTargetOf(broken, { "gradient/broken": { type: "gradient", value: "x" as never } })).toBeNull();
  });

  it("从文档取帧：矩形世界坐标与渐变值", () => {
    const state: DocState = createDocWithPage();
    const pageId = state.rootIds[0]!;
    const node = createNode("rect", { x: 10, y: 20, width: 200, height: 100, style: { fill: linear } });
    node.parentId = pageId;
    state.nodes[node.id] = node;
    state.nodes[pageId]!.children.push(node.id);
    const computed = gradientFrameOf(state, node.id);
    expect(computed?.quad).toEqual([
      { x: 10, y: 20 },
      { x: 210, y: 20 },
      { x: 210, y: 120 },
      { x: 10, y: 120 },
    ]);
    expect(computed?.value).toBe(linear);
  });

  it("祖辈旋转时四角取自 worldQuad，不按包围盒近似", () => {
    const state: DocState = createDocWithPage();
    const pageId = state.rootIds[0]!;
    const outer = createNode("frame", { x: 100, y: 100, width: 200, height: 200, rotation: 90 });
    outer.parentId = pageId;
    state.nodes[outer.id] = outer;
    state.nodes[pageId]!.children.push(outer.id);
    const inner = createNode("rect", { x: 50, y: 50, width: 100, height: 50, style: { fill: linear } });
    inner.parentId = outer.id;
    state.nodes[inner.id] = inner;
    outer.children.push(inner.id);

    const computed = gradientFrameOf(state, inner.id)!;
    expect(computed.quad).toEqual(worldQuad(state, inner.id));
    // 0–1 坐标正好落在四角上（含祖辈旋转）
    expect(unitToWorld(computed, 0, 0)).toEqual(computed.quad[0]);
    expect(unitToWorld(computed, 1, 0)).toEqual(computed.quad[1]);
    expect(unitToWorld(computed, 0, 1)).toEqual(computed.quad[3]);
    // 往返仍然成立
    const unit = worldToUnit(computed, ...Object.values(unitToWorld(computed, 0.3, 0.7)) as [number, number]);
    expect(unit).toMatchObject({ x: expect.closeTo(0.3, 6), y: expect.closeTo(0.7, 6) });
  });

  it("支持缩放 / 移动预览的几何与偏移", () => {
    const state: DocState = createDocWithPage();
    const pageId = state.rootIds[0]!;
    const node = createNode("rect", { x: 10, y: 20, width: 200, height: 100, style: { fill: linear } });
    node.parentId = pageId;
    state.nodes[node.id] = node;
    state.nodes[pageId]!.children.push(node.id);

    const widened = gradientFrameOf(state, node.id, { geometry: { x: 10, y: 20, width: 400, height: 100 } })!;
    expect(widened.quad[1]).toEqual({ x: 410, y: 20 });

    const moved = gradientFrameOf(state, node.id, { offset: { x: 15, y: -5 } })!;
    expect(moved.quad[0]).toEqual({ x: 25, y: 15 });
  });
});

describe("渐变手柄：坐标换算", () => {
  it("没有旋转时 0–1 直接映射到包围盒", () => {
    expect(unitToWorld(frame(), 0, 0.5)).toEqual({ x: 100, y: 150 });
    expect(unitToWorld(frame(), 1, 0.5)).toEqual({ x: 300, y: 150 });
  });

  it("90° 旋转绕包围盒中心", () => {
    const rotated = frame({ quad: quadOf(RECT, 90) });
    const world = unitToWorld(rotated, 0, 0.5);
    expect(world.x).toBeCloseTo(200);
    expect(world.y).toBeCloseTo(50);
    expect(worldToUnit(rotated, world.x, world.y)).toMatchObject({ x: expect.closeTo(0, 5), y: expect.closeTo(0.5, 5) });
  });

  it("worldToUnit 是 unitToWorld 的逆", () => {
    const rotated = frame({ quad: quadOf(RECT, 33) });
    for (const [x, y] of [
      [0.2, 0.3],
      [0.9, 0.1],
    ]) {
      const world = unitToWorld(rotated, x!, y!);
      const unit = worldToUnit(rotated, world.x, world.y);
      expect(unit.x).toBeCloseTo(x!);
      expect(unit.y).toBeCloseTo(y!);
    }
  });
});

describe("渐变手柄：命中", () => {
  it("端点与色标都给出世界坐标", () => {
    const handles = gradientHandles(frame());
    expect(handles.map((h) => h.kind)).toEqual(["from", "to", "stop", "stop"]);
    // 色标 0 与起点重合、色标 1 与终点重合
    expect(handles[2]).toMatchObject({ index: 0, x: 100, y: 150 });
    expect(handles[3]).toMatchObject({ index: 1, x: 300, y: 150 });
  });

  it("同位置时色标优先于端点", () => {
    const hit = hitGradientHandle(frame(), { x: 100, y: 151 }, 6);
    expect(hit).toMatchObject({ kind: "stop", index: 0 });
  });

  it("超出容差不算命中", () => {
    expect(hitGradientHandle(frame(), { x: 100, y: 200 }, 6)).toBeNull();
  });

  it("命中渐变线返回投影参数", () => {
    expect(hitGradientLine(frame(), { x: 200, y: 152 }, 4)).toBeCloseTo(0.5);
    expect(hitGradientLine(frame(), { x: 200, y: 170 }, 4)).toBeNull();
  });
});

describe("渐变手柄：拖动换算", () => {
  it("线性渐变拖起点 = 整条线平移", () => {
    const next = dragGradientHandle(frame(), { kind: "from", index: -1 }, { x: 100, y: 175 });
    // 起点下移 25px（= 0.25 高度），终点跟着下移
    expect(next.from).toMatchObject({ x: 0, y: 0.75 });
    expect(next.to).toMatchObject({ x: 1, y: 0.75 });
  });

  it("径向渐变拖中心只移动 from", () => {
    const radial = frame({ value: { ...linear, type: "radial" } });
    const next = dragGradientHandle(radial, { kind: "from", index: -1 }, { x: 200, y: 150 });
    expect(next.from).toMatchObject({ x: 0.5, y: 0.5 });
    expect(next.to).toEqual(radial.value.to);
  });

  it("拖终点直接写到指针位置", () => {
    const next = dragGradientHandle(frame(), { kind: "to", index: -1 }, { x: 200, y: 200 });
    expect(next.to.x).toBeCloseTo(0.5);
    expect(next.to.y).toBeCloseTo(1);
  });

  it("拖色标改 offset 并保持升序", () => {
    const value: GradientValue = {
      ...linear,
      stops: [
        { offset: 0.2, color: { value: "#000000" } },
        { offset: 0.8, color: { value: "#ffffff" } },
      ],
    };
    // 把 0.2 那个拖到中点 0.5：仍在前面
    const next = dragGradientHandle(frame({ value }), { kind: "stop", index: 0 }, { x: 200, y: 150 });
    expect(next.stops.map((stop) => stop.offset)).toEqual([0.5, 0.8]);
    // 拖过另一个色标后自动换位
    const swapped = dragGradientHandle(frame({ value }), { kind: "stop", index: 0 }, { x: 280, y: 150 });
    expect(swapped.stops.map((stop) => stop.offset)).toEqual([0.8, 0.9]);
  });

  it("色标投影超出线段时夹到 0–1", () => {
    const next = setStopOffset(frame(), 1, { x: 20, y: 150 });
    expect(next.stops.map((stop) => stop.offset)).toEqual([0, 0]);
  });
});

describe("渐变手柄：色标增删", () => {
  it("插入色标沿用最近的色标颜色，返回新下标", () => {
    const value: GradientValue = {
      ...linear,
      stops: [
        { offset: 0, color: { token: "color/a" } },
        { offset: 1, color: { value: "#ffffff" } },
      ],
    };
    const added = insertStopAt(value, 0.7);
    expect(added?.value.stops).toHaveLength(3);
    expect(added?.value.stops[1]?.color).toEqual({ value: "#ffffff" });
    expect(added?.index).toBe(1);
    expect(insertStopAt(value, 0.1)?.value.stops[0]?.color).toEqual({ token: "color/a" });
  });

  it("16 个色标后不再插入", () => {
    const value: GradientValue = {
      ...linear,
      stops: Array.from({ length: 16 }, (_, i) => ({ offset: i / 15, color: { value: "#000000" } })),
    };
    expect(insertStopAt(value, 0.5)).toBeNull();
  });

  it("只剩两个色标时拒绝删除", () => {
    expect(removeStopAt(linear, 0)).toBeNull();
    const three: GradientValue = {
      ...linear,
      stops: [
        { offset: 0, color: { value: "#000000" } },
        { offset: 0.5, color: { value: "#888888" } },
        { offset: 1, color: { value: "#ffffff" } },
      ],
    };
    expect(removeStopAt(three, 1)?.stops).toHaveLength(2);
  });
});
