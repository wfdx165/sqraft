import { describe, expect, it } from "vitest";
import {
  createEmptyDoc,
  createNode,
  resolvePaint,
  worldRect,
  defaultLayoutFor,
  nextPagePosition,
  worldQuad,
  DEFAULT_PAGE_WIDTH,
  PAGE_GAP,
  createLayoutSpec,
  firstPageId,
} from "../src/model";
import { subtreeWorldBounds } from "../src/model";
import {
  EFFECT_TYPES,
  createEffect,
  effectLayerScale,
  effectPadding,
  sanitizeEffect,
} from "../src/effects";
import { migrateDoc } from "../src/migrate";
import { layoutText, lineHeightPx, letterSpacingPx } from "../src/text";
import { DocStore } from "../src/store";
import { solveLayout } from "../src/layout";
import {
  flattenVector,
  hitVector,
  makeAnchor,
  normalizeVector,
  pointInVector,
  vectorBounds,
  type VectorPath,
} from "../src/vector";
import type { DocState } from "../src/model";
import { clampSides, hitPolygon, polygonPoints } from "../src/polygon";
import { materializeInstance } from "../src/component";

describe("命令系统", () => {
  it("创建 → 撤销 → 重做 后文档状态一致", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const rect = createNode("rect", { name: "R1", width: 10, height: 10 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    expect(store.doc.nodes[rect.id]).toBeTruthy();
    expect(store.doc.nodes[pageId].children).toContain(rect.id);

    store.undo();
    expect(store.doc.nodes[rect.id]).toBeUndefined();
    expect(store.doc.nodes[pageId].children).not.toContain(rect.id);

    store.redo();
    expect(store.doc.nodes[rect.id]).toBeTruthy();
    expect(store.doc.nodes[pageId].children).toContain(rect.id);
  });

  it("删除含子树的画板后撤销可完整恢复", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const child = createNode("rect", { name: "child" });
    const frame = createNode("frame", { name: "F", children: [child.id] });
    child.parentId = frame.id;
    store.apply({ type: "node.create", params: { nodes: [frame, child], parentId: pageId } });

    store.apply({ type: "node.delete", params: { nodeId: frame.id } });
    expect(store.doc.nodes[child.id]).toBeUndefined();

    store.undo();
    expect(store.doc.nodes[frame.id]).toBeTruthy();
    expect(store.doc.nodes[child.id]).toBeTruthy();
    expect(store.doc.nodes[frame.id].children).toContain(child.id);
  });

  it("同一起点应用同一命令序列，结果逐字节相等（确定性）", () => {
    const run = () => {
      const doc = createEmptyDoc();
      // 固定页面 id，排除 id 生成器对确定性比较的干扰
      const page = doc.nodes[doc.rootIds[0]];
      doc.nodes = { p: { ...page, id: "p" } };
      doc.rootIds = ["p"];
      const store = new DocStore(doc);
      const pageId = "p";
      const a = createNode("rect", { id: "a", x: 1, y: 2 });
      const b = createNode("ellipse", { id: "b", x: 3, y: 4 });
      store.apply([
        { type: "node.create", params: { nodes: [a], parentId: pageId } },
        { type: "node.create", params: { nodes: [b], parentId: pageId } },
        { type: "node.update", params: { nodeId: "a", patch: { x: 10 } } },
        { type: "token.define", params: { path: "color/accent", tokenType: "color", value: "#f00" } },
      ]);
      return JSON.stringify({ nodes: store.doc.nodes, tokens: store.doc.tokens });
    };
    expect(run()).toBe(run());
  });
});

describe("Token 改名", () => {
  it("改名后节点引用跟随，撤销后路径与引用双双还原", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const rect = createNode("rect", { name: "R", style: { fill: { token: "color/primary" }, stroke: { token: "color/primary" } } });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });

    store.apply({ type: "token.rename", params: { from: "color/primary", to: "brand/primary" } });
    expect(store.doc.tokens["color/primary"]).toBeUndefined();
    expect(store.doc.tokens["brand/primary"]).toEqual({ type: "color", value: "#3366ff" });
    expect(store.doc.nodes[rect.id].style.fill?.token).toBe("brand/primary");
    expect(store.doc.nodes[rect.id].style.stroke?.token).toBe("brand/primary");
    // 改名不改变渲染结果
    expect(resolvePaint(store.doc, store.doc.nodes[rect.id].style.fill)).toBe("#3366ff");

    store.undo();
    expect(store.doc.tokens["brand/primary"]).toBeUndefined();
    expect(store.doc.tokens["color/primary"]).toEqual({ type: "color", value: "#3366ff" });
    expect(store.doc.nodes[rect.id].style.fill?.token).toBe("color/primary");
    expect(store.doc.nodes[rect.id].style.stroke?.token).toBe("color/primary");

    store.redo();
    expect(store.doc.tokens["brand/primary"]).toBeTruthy();
    expect(store.doc.nodes[rect.id].style.fill?.token).toBe("brand/primary");
  });

  it("只改引用了该 Token 的节点，其它节点不动", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const a = createNode("rect", { name: "A", style: { fill: { token: "color/text" } } });
    const b = createNode("rect", { name: "B", style: { fill: { token: "color/primary" } } });
    store.apply([
      { type: "node.create", params: { nodes: [a], parentId: pageId } },
      { type: "node.create", params: { nodes: [b], parentId: pageId } },
    ]);

    store.apply({ type: "token.rename", params: { from: "color/text", to: "ink/text" } });
    expect(store.doc.nodes[a.id].style.fill?.token).toBe("ink/text");
    expect(store.doc.nodes[b.id].style.fill?.token).toBe("color/primary");
  });

  it("源不存在或目标重名时抛错且不改文档", () => {
    const store = new DocStore(createEmptyDoc());
    const before = JSON.stringify(store.doc.tokens);
    expect(() => store.apply({ type: "token.rename", params: { from: "color/nope", to: "x/y" } })).toThrow();
    expect(() => store.apply({ type: "token.rename", params: { from: "color/primary", to: "color/text" } })).toThrow();
    expect(() => store.apply({ type: "token.rename", params: { from: "color/primary", to: "color/primary" } })).toThrow();
    expect(JSON.stringify(store.doc.tokens)).toBe(before);
    // 失败不占撤销记录
    expect(store.canUndo).toBe(false);
  });
});

describe("布局求解器（golden）", () => {
  const base = createLayoutSpec({ direction: "horizontal", gap: 10, padding: { top: 0, right: 0, bottom: 0, left: 0 } });

  it("横向排列：固定项按序排布", () => {
    const r = solveLayout(
      base,
      [
        { id: "a", width: 100, height: 50, sizingW: "fixed", sizingH: "fixed" },
        { id: "b", width: 200, height: 80, sizingW: "fixed", sizingH: "fixed" },
      ],
      1000,
      500,
    );
    expect(r.items).toEqual([
      { id: "a", x: 0, y: 0, width: 100, height: 50 },
      { id: "b", x: 110, y: 0, width: 200, height: 80 },
    ]);
  });

  it("fill 子项均分剩余主轴空间", () => {
    const r = solveLayout(
      base,
      [
        { id: "a", width: 100, height: 50, sizingW: "fixed", sizingH: "fixed" },
        { id: "b", width: 0, height: 50, sizingW: "fill", sizingH: "fixed" },
        { id: "c", width: 0, height: 50, sizingW: "fill", sizingH: "fixed" },
      ],
      310,
      100,
    );
    expect(r.items[1]).toEqual({ id: "b", x: 110, y: 0, width: 95, height: 50 });
    expect(r.items[2]).toEqual({ id: "c", x: 215, y: 0, width: 95, height: 50 });
  });

  it("交叉轴居中与 end 对齐", () => {
    const r = solveLayout(
      { ...base, crossAlign: "center" },
      [{ id: "a", width: 100, height: 50, sizingW: "fixed", sizingH: "fixed" }],
      200,
      100,
    );
    expect(r.items[0].y).toBe(25);
  });

  it("space-between 均分间距", () => {
    const r = solveLayout(
      { ...base, mainAlign: "space-between" },
      [
        { id: "a", width: 50, height: 10, sizingW: "fixed", sizingH: "fixed" },
        { id: "b", width: 50, height: 10, sizingW: "fixed", sizingH: "fixed" },
      ],
      200,
      100,
    );
    expect(r.items[1].x).toBe(150);
  });

  it("padding 计入子项位置与内容尺寸", () => {
    const r = solveLayout(
      { ...base, padding: { top: 10, right: 20, bottom: 30, left: 40 } },
      [{ id: "a", width: 50, height: 20, sizingW: "fixed", sizingH: "fixed" }],
      300,
      200,
    );
    expect(r.items[0]).toMatchObject({ x: 40, y: 10 });
    expect(r.contentWidth).toBe(110);
    expect(r.contentHeight).toBe(60);
  });

  it("hug 轴不分配 fill，返回内容尺寸", () => {
    const r = solveLayout(
      base,
      [
        { id: "a", width: 50, height: 20, sizingW: "fixed", sizingH: "fixed" },
        { id: "b", width: 20, height: 20, sizingW: "fill", sizingH: "fixed" },
      ],
      undefined,
      undefined,
    );
    expect(r.items[1].width).toBe(20);
    expect(r.contentWidth).toBe(80);
    expect(r.contentHeight).toBe(20);
  });

  it("wrap 分行并支持 alignContent", () => {
    const spec = createLayoutSpec({
      direction: "horizontal",
      gap: 10,
      crossGap: 5,
      wrap: true,
      alignContent: "center",
    });
    const r = solveLayout(
      spec,
      [
        { id: "a", width: 60, height: 20, sizingW: "fixed", sizingH: "fixed" },
        { id: "b", width: 60, height: 20, sizingW: "fixed", sizingH: "fixed" },
        { id: "c", width: 60, height: 20, sizingW: "fixed", sizingH: "fixed" },
      ],
      130,
      100,
    );
    expect(r.items[0]).toMatchObject({ x: 0, y: 27.5 });
    expect(r.items[1]).toMatchObject({ x: 70, y: 27.5 });
    expect(r.items[2]).toMatchObject({ x: 0, y: 52.5 });
  });

  it("隐藏子项退出排布，绝对定位原样返回", () => {
    const r = solveLayout(
      base,
      [
        { id: "a", width: 50, height: 20, sizingW: "fixed", sizingH: "fixed" },
        { id: "b", width: 50, height: 20, sizingW: "fixed", sizingH: "fixed", visible: false },
        { id: "c", x: 33, y: 44, width: 10, height: 10, sizingW: "fixed", sizingH: "fixed", absolute: true },
      ],
      200,
      100,
    );
    expect(r.items.find((i) => i.id === "b")).toBeUndefined();
    expect(r.items.find((i) => i.id === "c")).toMatchObject({ x: 33, y: 44, width: 10, height: 10 });
  });
});

describe("Token 解析", () => {
  it("解析引用与字面量；缺失 Token 以示警色返回", () => {
    const doc = createEmptyDoc();
    expect(resolvePaint(doc, { token: "color/primary" })).toBe("#3366ff");
    expect(resolvePaint(doc, { value: "#123456" })).toBe("#123456");
    expect(resolvePaint(doc, { token: "color/missing" })).toBe("#ff00ff");
  });
});

describe("页面与世界坐标", () => {
  it("worldRect 累加页面与容器偏移", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const frame = createNode("frame", { x: 100, y: 50 });
    const rect = createNode("rect", { x: 10, y: 20 });
    rect.parentId = frame.id;
    frame.children = [rect.id];
    store.apply({ type: "node.create", params: { nodes: [frame, rect], parentId: pageId } });
    const r = worldRect(store.doc, rect.id);
    expect(r).toMatchObject({ x: 110, y: 70, width: rect.width, height: rect.height });
  });

  it("nextPagePosition 放在最右侧页面之右", () => {
    const store = new DocStore(createEmptyDoc());
    expect(nextPagePosition(store.doc)).toEqual({ x: DEFAULT_PAGE_WIDTH + PAGE_GAP, y: 0 });
  });
});

describe("矢量路径", () => {
  const line = (): VectorPath => ({
    closed: false,
    anchors: [makeAnchor(0, 0), makeAnchor(100, 0)],
  });

  it("包围盒包含手柄端点，归一化后最小坐标为 0", () => {
    const vector: VectorPath = {
      closed: false,
      anchors: [makeAnchor(20, 30, { outX: 40, outY: -10 }), makeAnchor(120, 30)],
    };
    expect(vectorBounds(vector)).toEqual({ x: 20, y: 20, width: 100, height: 10 });
    const { vector: n, bounds } = normalizeVector(vector.anchors, vector.closed);
    expect(bounds).toEqual({ x: 20, y: 20, width: 100, height: 10 });
    expect(n.anchors[0].x).toBe(0);
    expect(n.anchors[0].y).toBe(10);
    expect(n.anchors[0].outX).toBe(40);
  });

  it("创建路径时以父容器坐标归一化并推导节点框", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const path = createNode("path", {
      name: "P",
      x: 0,
      y: 0,
      vector: { closed: false, anchors: [makeAnchor(30, 40), makeAnchor(130, 90)] },
    });
    store.apply({ type: "node.create", params: { nodes: [path], parentId: pageId } });
    const saved = store.doc.nodes[path.id];
    expect(saved.x).toBe(30);
    expect(saved.y).toBe(40);
    expect(saved.width).toBe(100);
    expect(saved.height).toBe(50);
    expect(saved.vector?.anchors[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("改 vector 时重新推导节点框，撤销恢复上一版几何", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const path = createNode("path", {
      vector: { closed: false, anchors: [makeAnchor(0, 0), makeAnchor(100, 0)] },
    });
    store.apply({ type: "node.create", params: { nodes: [path], parentId: pageId } });

    store.apply({
      type: "node.update",
      params: {
        nodeId: path.id,
        patch: { vector: { closed: false, anchors: [makeAnchor(10, 10), makeAnchor(10, 60)] } },
      },
    });
    expect(store.doc.nodes[path.id].x).toBe(10);
    expect(store.doc.nodes[path.id].width).toBe(1);
    expect(store.doc.nodes[path.id].height).toBe(50);

    store.undo();
    expect(store.doc.nodes[path.id].x).toBe(0);
    expect(store.doc.nodes[path.id].width).toBe(100);
    expect(store.doc.nodes[path.id].height).toBe(1);
  });

  it("只改宽高时按比例缩放锚点与手柄", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const path = createNode("path", {
      vector: {
        closed: false,
        anchors: [makeAnchor(0, 0, { outX: 10 }), makeAnchor(100, 50)],
      },
    });
    store.apply({ type: "node.create", params: { nodes: [path], parentId: pageId } });
    store.apply({ type: "node.update", params: { nodeId: path.id, patch: { width: 200, height: 100 } } });
    const saved = store.doc.nodes[path.id];
    expect(saved.width).toBe(200);
    expect(saved.vector?.anchors[1]).toMatchObject({ x: 200, y: 100 });
    expect(saved.vector?.anchors[0].outX).toBe(20);
  });

  it("扁平路径垂直缩放后仍保持包围盒与几何一致", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const path = createNode("path", {
      vector: { closed: false, anchors: [makeAnchor(0, 0), makeAnchor(100, 0)] },
    });
    store.apply({ type: "node.create", params: { nodes: [path], parentId: pageId } });
    store.apply({ type: "node.update", params: { nodeId: path.id, patch: { height: 80 } } });
    const saved = store.doc.nodes[path.id];
    expect(saved.height).toBe(1);
    expect(saved.vector?.anchors.every((a) => a.y === 0)).toBe(true);
  });

  it("闭合少于 3 个锚点时抛错且不占撤销记录", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const path = createNode("path", { vector: line() });
    store.apply({ type: "node.create", params: { nodes: [path], parentId: pageId } });
    expect(() =>
      store.apply({
        type: "node.update",
        params: { nodeId: path.id, patch: { vector: { closed: true, anchors: line().anchors } } },
      }),
    ).toThrow();
    expect(store.doc.nodes[path.id].vector?.closed).toBe(false);
    store.undo();
    expect(store.doc.nodes[path.id]).toBeUndefined();
  });

  it("采样、描边距离与填充内部命中", () => {
    const square: VectorPath = {
      closed: true,
      anchors: [makeAnchor(0, 0), makeAnchor(100, 0), makeAnchor(100, 100), makeAnchor(0, 100)],
    };
    expect(flattenVector(square)).toHaveLength(5);
    expect(hitVector(square, 50, 50, 1, true)).toBe(true);
    expect(hitVector(square, 50, 50, 1, false)).toBe(false);
    expect(hitVector(square, 101, 50, 2, true)).toBe(true);
    expect(hitVector(square, 150, 150, 2, true)).toBe(false);
    expect(pointInVector(square, 50, 50)).toBe(true);
  });
});

describe("参数化多边形", () => {
  it("边数夹紧到 3–12，非法值回落为 3", () => {
    expect(clampSides(undefined)).toBe(3);
    expect(clampSides(2)).toBe(3);
    expect(clampSides(99)).toBe(12);
    expect(clampSides(6.4)).toBe(6);
    expect(clampSides(Number.NaN)).toBe(3);
  });

  it("三角形顶点朝上且撑满包围盒", () => {
    const pts = polygonPoints(3, 120, 90);
    expect(pts).toHaveLength(3);
    // 顶点在上边中点
    const apex = pts.reduce((a, b) => (b.y < a.y ? b : a));
    expect(apex.x).toBeCloseTo(60);
    expect(apex.y).toBeCloseTo(0);
    // 底边两点在下边左右角
    const base = pts.filter((p) => p !== apex).sort((a, b) => a.x - b.x);
    expect(base[0].x).toBeCloseTo(0);
    expect(base[0].y).toBeCloseTo(90);
    expect(base[1].x).toBeCloseTo(120);
    expect(base[1].y).toBeCloseTo(90);
  });

  it("改边数只改顶点数，不改包围盒", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const poly = createNode("polygon", { x: 10, y: 20, width: 120, height: 90, sides: 3 });
    store.apply({ type: "node.create", params: { nodes: [poly], parentId: pageId } });
    store.apply({ type: "node.update", params: { nodeId: poly.id, patch: { sides: 6 } } });
    const saved = store.doc.nodes[poly.id];
    expect(saved.sides).toBe(6);
    expect(saved.width).toBe(120);
    expect(saved.height).toBe(90);
    expect(polygonPoints(saved.sides, saved.width, saved.height)).toHaveLength(6);
    store.undo();
    expect(store.doc.nodes[poly.id].sides).toBe(3);
  });

  it("创建时创建边数夹紧，缩放顶点随包围盒走", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const poly = createNode("polygon", { width: 100, height: 100, sides: 40 });
    store.apply({ type: "node.create", params: { nodes: [poly], parentId: pageId } });
    expect(store.doc.nodes[poly.id].sides).toBe(12);
    store.apply({ type: "node.update", params: { nodeId: poly.id, patch: { width: 200, height: 50 } } });
    const saved = store.doc.nodes[poly.id];
    const pts = polygonPoints(saved.sides, saved.width, saved.height);
    expect(Math.max(...pts.map((p) => p.x))).toBeCloseTo(200);
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(50);
  });

  it("命中：填充可点内部，无填充只认描边", () => {
    const pts = polygonPoints(3, 100, 100);
    expect(hitPolygon(pts, 50, 60, 1, true)).toBe(true);
    expect(hitPolygon(pts, 50, 60, 1, false)).toBe(false);
    expect(hitPolygon(pts, 0, 100, 2, false)).toBe(true);
    expect(hitPolygon(pts, 50, -10, 2, false)).toBe(false);
  });
});

describe("命令原子性与参数不可变", () => {
  it("批命令中途非法：整批不生效、不进撤销栈", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const before = JSON.stringify(store.doc);
    const rect = createNode("rect", { name: "R" });
    const bad = createNode("path", {
      vector: { closed: true, anchors: [makeAnchor(0, 0), makeAnchor(10, 10)] },
    });
    expect(() =>
      store.apply([
        { type: "node.create", params: { nodes: [rect], parentId: pageId } },
        { type: "node.create", params: { nodes: [bad], parentId: pageId } },
      ]),
    ).toThrow();
    expect(JSON.stringify(store.doc)).toBe(before);
    expect(store.canUndo).toBe(false);
  });

  it("批命令全部合法时一步撤销整批", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const a = createNode("rect", { name: "A" });
    const b = createNode("rect", { name: "B" });
    store.apply([
      { type: "node.create", params: { nodes: [a], parentId: pageId } },
      { type: "node.create", params: { nodes: [b], parentId: pageId } },
    ]);
    expect(store.doc.nodes[a.id]).toBeTruthy();
    expect(store.doc.nodes[b.id]).toBeTruthy();
    store.undo();
    expect(store.doc.nodes[a.id]).toBeUndefined();
    expect(store.doc.nodes[b.id]).toBeUndefined();
  });

  it("node.create 不改写调用方传入的节点对象", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const path = createNode("path", {
      x: 5,
      y: 6,
      vector: { closed: false, anchors: [makeAnchor(30, 40), makeAnchor(130, 90)] },
    });
    const snapshot = JSON.stringify(path);
    store.apply({ type: "node.create", params: { nodes: [path], parentId: pageId } });
    expect(JSON.stringify(path)).toBe(snapshot);
    expect(path.parentId).toBeNull();
    // 文档里是归一化后的副本
    expect(store.doc.nodes[path.id].x).toBe(35);
  });
});

describe("组件：创建与实例物化", () => {
  function setup() {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const frame = createNode("frame", {
      name: "卡片",
      width: 200,
      height: 120,
      style: { fill: { token: "color/surface" } },
    });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    const title = createNode("text", {
      name: "标题",
      x: 10,
      y: 10,
      width: 80,
      height: 24,
      text: "标题",
      style: { fill: { token: "color/text" } },
    });
    store.apply({ type: "node.create", params: { nodes: [title], parentId: frame.id } });
    return { store, pageId, frame, title };
  }

  it("页面顶层的画板转为主组件，命名「组件 N」，撤销恢复", () => {
    const { store, frame } = setup();
    store.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
    expect(store.doc.nodes[frame.id].type).toBe("component");
    expect(store.doc.nodes[frame.id].name).toBe("组件 1");
    store.undo();
    expect(store.doc.nodes[frame.id].type).toBe("frame");
    expect(store.doc.nodes[frame.id].name).toBe("卡片");
  });

  it("嵌套画板转组件时提升到页面顶层，世界坐标不变", () => {
    const { store, pageId, frame } = setup();
    const nested = createNode("frame", { name: "内层画板", x: 15, y: 20, width: 60, height: 40 });
    store.apply({ type: "node.create", params: { nodes: [nested], parentId: frame.id } });
    const before = worldRect(store.doc, nested.id)!;

    store.apply({ type: "component.create", params: { nodeIds: [nested.id] } });
    const made = store.doc.nodes[nested.id];
    expect(made.type).toBe("component");
    expect(made.parentId).toBe(pageId);
    const after = worldRect(store.doc, nested.id)!;
    expect(after).toEqual(before);

    store.undo();
    expect(store.doc.nodes[nested.id].type).toBe("frame");
    expect(store.doc.nodes[nested.id].parentId).toBe(frame.id);
    expect(worldRect(store.doc, nested.id)).toEqual(before);
  });

  it("插入实例物化整棵子树，mainId 与派生 id 正确，撤销删整棵", () => {
    const { store, pageId, frame, title } = setup();
    store.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
    const instanceId = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: frame.id, parentId: pageId, nodeId: instanceId, x: 50, y: 60 },
    });

    const root = store.doc.nodes[instanceId];
    expect(root.type).toBe("instance");
    expect(root.componentId).toBe(frame.id);
    expect(root.mainId).toBe(frame.id);
    expect(root.x).toBe(50);
    expect(root.y).toBe(60);
    expect(root.width).toBe(200);
    expect(root.style.fill).toEqual({ token: "color/surface" });
    expect(root.children).toHaveLength(1);
    expect(store.doc.nodes[pageId].children).toContain(instanceId);

    const clone = store.doc.nodes[root.children[0]];
    expect(clone.id).toBe(`${instanceId}:${title.id}`);
    expect(clone.mainId).toBe(title.id);
    expect(clone.parentId).toBe(instanceId);
    expect(clone.text).toBe("标题");
    expect(clone.style.fill).toEqual({ token: "color/text" });

    store.undo();
    expect(store.doc.nodes[instanceId]).toBeUndefined();
    expect(store.doc.nodes[`${instanceId}:${title.id}`]).toBeUndefined();
    expect(store.doc.nodes[pageId].children).not.toContain(instanceId);
  });

  it("组件不能直接或间接包含自身", () => {
    const { store, frame } = setup();
    store.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
    const before = JSON.stringify(store.doc);
    const instanceId = createNode("instance").id;
    expect(() =>
      store.apply({
        type: "instance.create",
        params: { componentId: frame.id, parentId: frame.id, nodeId: instanceId, x: 0, y: 0 },
      }),
    ).toThrow(/包含自身/);
    expect(JSON.stringify(store.doc)).toBe(before);
  });

  it("两个实例各自派生独立 id，互不串味", () => {
    const { store, pageId, frame } = setup();
    store.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
    const a = createNode("instance").id;
    const b = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: frame.id, parentId: pageId, nodeId: a, x: 0, y: 0 },
    });
    store.apply({
      type: "instance.create",
      params: { componentId: frame.id, parentId: pageId, nodeId: b, x: 300, y: 0 },
    });
    const aChild = store.doc.nodes[a].children[0];
    const bChild = store.doc.nodes[b].children[0];
    expect(aChild.startsWith(`${a}:`)).toBe(true);
    expect(bChild.startsWith(`${b}:`)).toBe(true);
    expect(aChild).not.toBe(bChild);
  });

  it("同一实例重复物化得到完全相同的派生 id", () => {
    const { store, pageId, frame } = setup();
    store.apply({ type: "component.create", params: { nodeIds: [frame.id] } });
    const ids = (): string[] =>
      materializeInstance(store.doc, frame.id, "n_fixed", pageId, 0, 0).map((n) => n.id);
    expect(ids()).toEqual(ids());
  });
});

describe("组件：母版同步", () => {
  function setup() {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const master = createNode("frame", {
      name: "卡片",
      width: 200,
      height: 120,
      style: { fill: { token: "color/surface" } },
    });
    store.apply({ type: "node.create", params: { nodes: [master], parentId: pageId } });
    const label = createNode("text", {
      name: "标题",
      x: 10,
      y: 10,
      width: 80,
      height: 24,
      text: "标题",
      style: { fill: { token: "color/text" } },
    });
    store.apply({ type: "node.create", params: { nodes: [label], parentId: master.id } });
    store.apply({ type: "component.create", params: { nodeIds: [master.id] } });
    const instanceId = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: master.id, parentId: pageId, nodeId: instanceId, x: 300, y: 0 },
    });
    return { store, pageId, master, label, instanceId, cloneId: `${instanceId}:${label.id}` };
  }

  it("母版文案改动同步到实例，一次撤销同时回退", () => {
    const { store, label, cloneId } = setup();
    store.apply({ type: "node.update", params: { nodeId: label.id, patch: { text: "新标题" } } });
    expect(store.doc.nodes[cloneId].text).toBe("新标题");

    store.undo();
    expect(store.doc.nodes[label.id].text).toBe("标题");
    expect(store.doc.nodes[cloneId].text).toBe("标题");

    store.redo();
    expect(store.doc.nodes[cloneId].text).toBe("新标题");
  });

  it("母版尺寸与样式同步到实例根", () => {
    const { store, master, instanceId } = setup();
    store.apply({
      type: "node.update",
      params: { nodeId: master.id, patch: { width: 260, style: { fill: { token: "color/primary" } } } },
    });
    expect(store.doc.nodes[instanceId].width).toBe(260);
    expect(store.doc.nodes[instanceId].style.fill).toEqual({ token: "color/primary" });

    store.undo();
    expect(store.doc.nodes[instanceId].width).toBe(200);
    expect(store.doc.nodes[instanceId].style.fill).toEqual({ token: "color/surface" });
  });

  it("母版新增、重排、删除子节点时实例跟随，派生 id 稳定", () => {
    const { store, master, label, instanceId } = setup();
    const extra = createNode("rect", { name: "角标", x: 5, y: 5, width: 20, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [extra], parentId: master.id } });
    const extraClone = `${instanceId}:${extra.id}`;
    expect(store.doc.nodes[instanceId].children).toContain(extraClone);
    expect(store.doc.nodes[extraClone].mainId).toBe(extra.id);

    // 重排
    store.apply({
      type: "node.update",
      params: { nodeId: master.id, patch: { children: [extra.id, label.id] } },
    });
    expect(store.doc.nodes[instanceId].children).toEqual([extraClone, `${instanceId}:${label.id}`]);

    // 删除
    store.apply({ type: "node.delete", params: { nodeId: extra.id } });
    expect(store.doc.nodes[extraClone]).toBeUndefined();
    expect(store.doc.nodes[instanceId].children).toEqual([`${instanceId}:${label.id}`]);

    // 撤销删除：母版与实例一起恢复
    store.undo();
    expect(store.doc.nodes[extra.id]).toBeTruthy();
    expect(store.doc.nodes[extraClone]).toBeTruthy();
  });

  it("字段级覆盖在母版同步时保留", () => {
    const { store, label, instanceId, cloneId } = setup();
    store.apply({
      type: "node.update",
      params: {
        nodeId: instanceId,
        patch: { overrides: { [label.id]: { style: { fill: { token: "color/primary" } } } } },
      },
    });
    // 覆盖只在下一次同步时落到克隆上
    store.apply({ type: "node.update", params: { nodeId: label.id, patch: { text: "新标题" } } });
    expect(store.doc.nodes[cloneId].text).toBe("新标题");
    expect(store.doc.nodes[cloneId].style.fill).toEqual({ token: "color/primary" });

    // 清掉覆盖后再次同步，回到母版样式
    store.apply({ type: "node.update", params: { nodeId: instanceId, patch: { overrides: {} } } });
    store.apply({ type: "node.update", params: { nodeId: label.id, patch: { text: "再改一次" } } });
    expect(store.doc.nodes[cloneId].style.fill).toEqual({ token: "color/text" });
  });

  it("嵌套组件按依赖顺序级联同步，一次撤销全部回退", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];

    const bMaster = createNode("frame", {
      name: "B",
      width: 100,
      height: 50,
      style: { fill: { token: "color/surface" } },
    });
    store.apply({ type: "node.create", params: { nodes: [bMaster], parentId: pageId } });
    const bText = createNode("text", {
      name: "B 文案",
      x: 5,
      y: 5,
      width: 40,
      height: 20,
      text: "B",
      style: { fill: { token: "color/text" } },
    });
    store.apply({ type: "node.create", params: { nodes: [bText], parentId: bMaster.id } });
    store.apply({ type: "component.create", params: { nodeIds: [bMaster.id] } });

    const aMaster = createNode("frame", {
      name: "A",
      width: 300,
      height: 200,
      style: { fill: { token: "color/surface" } },
    });
    store.apply({ type: "node.create", params: { nodes: [aMaster], parentId: pageId } });
    store.apply({ type: "component.create", params: { nodeIds: [aMaster.id] } });

    // A 母版里放一个 B 的实例
    const bInA = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: bMaster.id, parentId: aMaster.id, nodeId: bInA, x: 20, y: 20 },
    });

    // A 的实例
    const aInstance = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: aMaster.id, parentId: pageId, nodeId: aInstance, x: 500, y: 0 },
    });
    const nestedB = `${aInstance}:${bInA}`;
    const nestedText = `${nestedB}:${bText.id}`;
    expect(store.doc.nodes[nestedText].text).toBe("B");

    // 改 B 的母版：B 的实例（含 A 母版里的那个）→ A 母版变化 → A 的实例
    store.apply({ type: "node.update", params: { nodeId: bText.id, patch: { text: "B2" } } });
    expect(store.doc.nodes[`${bInA}:${bText.id}`].text).toBe("B2");
    expect(store.doc.nodes[nestedText].text).toBe("B2");
    store.undo();
    expect(store.doc.nodes[bText.id].text).toBe("B");
    expect(store.doc.nodes[`${bInA}:${bText.id}`].text).toBe("B");
    expect(store.doc.nodes[nestedText].text).toBe("B");
  });
});

describe("组件：任意选区创建", () => {
  function blank() {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    return { store, pageId };
  }

  it("多选包一层组件，尺寸取并集，世界坐标不变，一次撤销回退", () => {
    const { store, pageId } = blank();
    const frame = createNode("frame", {
      name: "A",
      x: 100,
      y: 100,
      width: 100,
      height: 80,
      style: { fill: { token: "color/surface" } },
    });
    const rect = createNode("rect", {
      name: "B",
      x: 250,
      y: 160,
      width: 60,
      height: 40,
      style: { fill: { token: "color/primary" } },
    });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const worldFrame = worldRect(store.doc, frame.id)!;
    const worldRectB = worldRect(store.doc, rect.id)!;

    const componentId = createNode("component").id;
    store.apply({
      type: "component.create",
      params: { nodeIds: [rect.id, frame.id], componentId },
    });

    const comp = store.doc.nodes[componentId];
    expect(comp.type).toBe("component");
    expect(comp.parentId).toBe(pageId);
    expect(comp.x).toBe(100);
    expect(comp.y).toBe(100);
    expect(comp.width).toBe(210);
    expect(comp.height).toBe(100);
    expect(comp.children).toEqual([rect.id, frame.id]);
    expect(worldRect(store.doc, rect.id)).toEqual(worldRectB);
    expect(worldRect(store.doc, frame.id)).toEqual(worldFrame);

    store.undo();
    expect(store.doc.nodes[componentId]).toBeUndefined();
    expect(store.doc.nodes[rect.id].parentId).toBe(pageId);
    expect(store.doc.nodes[frame.id].parentId).toBe(pageId);
    expect(worldRect(store.doc, rect.id)).toEqual(worldRectB);
    expect(worldRect(store.doc, frame.id)).toEqual(worldFrame);
  });

  it("单个非容器节点也会被包成组件", () => {
    const { store, pageId } = blank();
    const rect = createNode("rect", { name: "R", x: 10, y: 20, width: 30, height: 40 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const componentId = createNode("component").id;
    store.apply({ type: "component.create", params: { nodeIds: [rect.id], componentId } });
    const comp = store.doc.nodes[componentId];
    expect(comp.width).toBe(30);
    expect(comp.height).toBe(40);
    expect(comp.children).toEqual([rect.id]);
    expect(store.doc.nodes[rect.id].x).toBe(0);
    expect(store.doc.nodes[rect.id].y).toBe(0);
    expect(worldRect(store.doc, rect.id)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("选区包含祖先与后代时只处理最外层节点", () => {
    const { store, pageId } = blank();
    const frame = createNode("frame", { name: "A", x: 0, y: 0, width: 100, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    const child = createNode("rect", { name: "B", x: 10, y: 10, width: 20, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [child], parentId: frame.id } });

    store.apply({ type: "component.create", params: { nodeIds: [frame.id, child.id] } });
    expect(store.doc.nodes[frame.id].type).toBe("component");
    expect(store.doc.nodes[child.id].parentId).toBe(frame.id);
    expect(store.doc.nodes[frame.id].children).toEqual([child.id]);
  });

  it("跨页面选区与组件嵌套组件都被拒绝，且文档不变", () => {
    const { store, pageId } = blank();
    const page2 = createNode("page", { name: "页面 2", x: 2000, width: 800, height: 600 });
    store.apply({ type: "node.create", params: { nodes: [page2], parentId: null } });
    const a = createNode("rect", { name: "A", width: 10, height: 10 });
    const b = createNode("rect", { name: "B", width: 10, height: 10 });
    store.apply({ type: "node.create", params: { nodes: [a], parentId: pageId } });
    store.apply({ type: "node.create", params: { nodes: [b], parentId: page2.id } });

    const before = JSON.stringify(store.doc);
    expect(() =>
      store.apply({
        type: "component.create",
        params: { nodeIds: [a.id, b.id], componentId: createNode("component").id },
      }),
    ).toThrow(/同一页面/);
    expect(JSON.stringify(store.doc)).toBe(before);

    const nestedMaster = createNode("frame", { name: "母版", width: 50, height: 50 });
    store.apply({ type: "node.create", params: { nodes: [nestedMaster], parentId: pageId } });
    store.apply({ type: "component.create", params: { nodeIds: [nestedMaster.id] } });
    const inner = createNode("frame", { name: "内层", width: 20, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [inner], parentId: nestedMaster.id } });
    expect(() => store.apply({ type: "component.create", params: { nodeIds: [inner.id] } })).toThrow(
      /组件不能嵌套组件/,
    );
    expect(store.doc.nodes[inner.id].type).toBe("frame");
  });
});

describe("组件：实例覆盖", () => {
  function setup() {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const master = createNode("frame", {
      name: "卡片",
      width: 200,
      height: 120,
      style: { fill: { token: "color/surface" } },
    });
    store.apply({ type: "node.create", params: { nodes: [master], parentId: pageId } });
    const label = createNode("text", {
      name: "标题",
      x: 10,
      y: 10,
      width: 80,
      height: 24,
      text: "标题",
      style: { fill: { token: "color/text" } },
    });
    store.apply({ type: "node.create", params: { nodes: [label], parentId: master.id } });
    store.apply({ type: "component.create", params: { nodeIds: [master.id] } });
    const instanceId = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: master.id, parentId: pageId, nodeId: instanceId, x: 300, y: 0 },
    });
    return { store, pageId, master, label, instanceId, cloneId: `${instanceId}:${label.id}` };
  }

  it("编辑实例内部字段写入覆盖，改回母版值自动清除，撤销一致", () => {
    const { store, label, instanceId, cloneId } = setup();
    store.apply({ type: "node.update", params: { nodeId: cloneId, patch: { text: "实例文案" } } });
    expect(store.doc.nodes[instanceId].overrides?.[label.id]?.text).toBe("实例文案");

    store.apply({ type: "node.update", params: { nodeId: cloneId, patch: { text: "标题" } } });
    expect(store.doc.nodes[instanceId].overrides?.[label.id]).toBeUndefined();

    // 撤销回到「有覆盖」状态
    store.undo();
    expect(store.doc.nodes[cloneId].text).toBe("实例文案");
    expect(store.doc.nodes[instanceId].overrides?.[label.id]?.text).toBe("实例文案");
    store.undo();
    expect(store.doc.nodes[cloneId].text).toBe("标题");
    expect(store.doc.nodes[instanceId].overrides?.[label.id]).toBeUndefined();
  });

  it("样式覆盖按子字段记录，母版改其它字段仍然同步", () => {
    const { store, label, instanceId, cloneId } = setup();
    const clone = store.doc.nodes[cloneId];
    store.apply({
      type: "node.update",
      params: { nodeId: cloneId, patch: { style: { ...clone.style, fill: { token: "color/primary" } } } },
    });
    expect(store.doc.nodes[instanceId].overrides?.[label.id]?.style).toEqual({
      fill: { token: "color/primary" },
    });

    store.apply({ type: "node.update", params: { nodeId: label.id, patch: { text: "新标题" } } });
    expect(store.doc.nodes[cloneId].text).toBe("新标题");
    expect(store.doc.nodes[cloneId].style.fill).toEqual({ token: "color/primary" });
  });

  it("实例根的尺寸覆盖优先于母版同步，可逐字段重置", () => {
    const { store, master, instanceId } = setup();
    store.apply({ type: "node.update", params: { nodeId: instanceId, patch: { width: 400 } } });
    expect(store.doc.nodes[instanceId].overrides?.[master.id]?.width).toBe(400);

    store.apply({ type: "node.update", params: { nodeId: master.id, patch: { width: 260 } } });
    expect(store.doc.nodes[instanceId].width).toBe(400);

    store.apply({
      type: "instance.resetOverride",
      params: { instanceId, mainId: master.id, fields: ["width"] },
    });
    expect(store.doc.nodes[instanceId].width).toBe(260);
    expect(store.doc.nodes[instanceId].overrides?.[master.id]).toBeUndefined();
  });

  it("属性绑定的字段不写覆盖", () => {
    const { store, master, label, instanceId, cloneId } = setup();
    store.apply({
      type: "node.update",
      params: {
        nodeId: master.id,
        patch: {
          propertyDefs: [{ id: "p1", name: "标题", type: "text", targetMainId: label.id }],
        },
      },
    });
    store.apply({ type: "node.update", params: { nodeId: cloneId, patch: { text: "属性文案" } } });
    expect(store.doc.nodes[instanceId].overrides?.[label.id]).toBeUndefined();
  });

  it("实例名跟随母版改名，手动改名后不再跟随", () => {
    const { store, master, instanceId } = setup();
    store.apply({ type: "node.update", params: { nodeId: master.id, patch: { name: "按钮" } } });
    expect(store.doc.nodes[instanceId].name).toBe("按钮");

    store.apply({ type: "node.update", params: { nodeId: instanceId, patch: { name: "主按钮" } } });
    expect(store.doc.nodes[instanceId].overrides?.[master.id]?.name).toBe("主按钮");

    store.apply({ type: "node.update", params: { nodeId: master.id, patch: { name: "新按钮" } } });
    expect(store.doc.nodes[instanceId].name).toBe("主按钮");

    store.apply({
      type: "instance.resetOverride",
      params: { instanceId, mainId: master.id, fields: ["name"] },
    });
    expect(store.doc.nodes[instanceId].name).toBe("新按钮");
  });

  it("全部重置恢复所有覆盖字段，撤销可整体回退", () => {
    const { store, master, label, instanceId, cloneId } = setup();
    store.apply({ type: "node.update", params: { nodeId: cloneId, patch: { text: "实例文案" } } });
    store.apply({ type: "node.update", params: { nodeId: instanceId, patch: { width: 400 } } });
    expect(Object.keys(store.doc.nodes[instanceId].overrides ?? {})).toHaveLength(2);

    store.apply({ type: "instance.resetOverride", params: { instanceId } });
    expect(store.doc.nodes[instanceId].width).toBe(200);
    expect(store.doc.nodes[cloneId].text).toBe("标题");
    expect(store.doc.nodes[instanceId].overrides).toBeUndefined();

    store.undo();
    expect(store.doc.nodes[instanceId].width).toBe(400);
    expect(store.doc.nodes[cloneId].text).toBe("实例文案");
    expect(store.doc.nodes[instanceId].overrides?.[label.id]?.text).toBe("实例文案");
    expect(store.doc.nodes[instanceId].overrides?.[master.id]?.width).toBe(400);
  });
});

describe("组件：插槽", () => {
  function setup() {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const master = createNode("frame", {
      name: "卡片",
      width: 300,
      height: 200,
      style: { fill: { token: "color/surface" } },
    });
    store.apply({ type: "node.create", params: { nodes: [master], parentId: pageId } });
    const content = createNode("frame", { name: "内容区", x: 20, y: 60, width: 260, height: 120 });
    store.apply({ type: "node.create", params: { nodes: [content], parentId: master.id } });
    const label = createNode("text", {
      name: "默认文案",
      x: 10,
      y: 10,
      width: 80,
      height: 24,
      text: "默认文案",
      style: { fill: { token: "color/text" } },
    });
    store.apply({ type: "node.create", params: { nodes: [label], parentId: content.id } });
    store.apply({ type: "component.create", params: { nodeIds: [master.id] } });
    store.apply({ type: "slot.create", params: { nodeId: content.id, name: "body" } });

    const instanceId = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: master.id, parentId: pageId, nodeId: instanceId, x: 400, y: 0 },
    });
    const slotClone = `${instanceId}:${content.id}`;
    const labelClone = `${slotClone}:${label.id}`;

    const rect = createNode("rect", {
      name: "用户内容",
      x: 600,
      y: 400,
      width: 80,
      height: 40,
      style: { fill: { token: "color/primary" } },
    });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    return { store, pageId, master, content, label, instanceId, slotClone, labelClone, rect };
  }

  it("容器转插槽保留默认内容，实例物化出未填充插槽", () => {
    const { store, content, slotClone, labelClone } = setup();
    expect(store.doc.nodes[content.id].type).toBe("slot");
    expect(store.doc.nodes[content.id].name).toBe("body");
    const slot = store.doc.nodes[slotClone];
    expect(slot.type).toBe("slot");
    expect(slot.mainId).toBe(content.id);
    expect(slot.slotFilled).toBeUndefined();
    expect(slot.children).toEqual([labelClone]);
    expect(store.doc.nodes[labelClone].mainId).toBe(store.doc.nodes[labelClone].mainId);
  });

  it("母版默认内容、插槽名与尺寸同步到未填充实例", () => {
    const { store, content, label, slotClone, labelClone } = setup();
    store.apply({ type: "node.update", params: { nodeId: label.id, patch: { text: "新默认" } } });
    expect(store.doc.nodes[labelClone].text).toBe("新默认");

    store.apply({ type: "node.update", params: { nodeId: content.id, patch: { name: "footer" } } });
    expect(store.doc.nodes[slotClone].name).toBe("footer");

    store.apply({ type: "node.update", params: { nodeId: content.id, patch: { width: 240 } } });
    expect(store.doc.nodes[slotClone].width).toBe(240);
  });

  it("填充替换默认内容，母版同步不覆盖已填充内容，撤销恢复", () => {
    const { store, slotClone, labelClone, rect } = setup();
    const before = worldRect(store.doc, rect.id)!;
    store.apply({ type: "slot.fill", params: { slotId: slotClone, nodeIds: [rect.id] } });

    const slot = store.doc.nodes[slotClone];
    expect(slot.slotFilled).toBe(true);
    expect(slot.children).toEqual([rect.id]);
    expect(store.doc.nodes[labelClone]).toBeUndefined();
    expect(store.doc.nodes[rect.id].parentId).toBe(slotClone);
    expect(worldRect(store.doc, rect.id)).toEqual(before);

    // 母版默认内容变化不影响已填充插槽
    store.apply({ type: "node.update", params: { nodeId: store.doc.nodes[slotClone].mainId!, patch: { name: "body2" } } });
    expect(store.doc.nodes[slotClone].name).toBe("body2");
    expect(store.doc.nodes[slotClone].children).toEqual([rect.id]);

    store.undo();
    expect(store.doc.nodes[slotClone].name).toBe("body");
    store.undo();
    expect(store.doc.nodes[slotClone].slotFilled).toBeUndefined();
    expect(store.doc.nodes[slotClone].children).toEqual([labelClone]);
    expect(store.doc.nodes[rect.id].parentId).not.toBe(slotClone);
  });

  it("清空插槽恢复默认内容，撤销回到已填充", () => {
    const { store, slotClone, labelClone, rect } = setup();
    store.apply({ type: "slot.fill", params: { slotId: slotClone, nodeIds: [rect.id] } });
    store.apply({ type: "slot.clear", params: { slotId: slotClone } });

    const slot = store.doc.nodes[slotClone];
    expect(slot.slotFilled).toBe(false);
    expect(slot.children).toEqual([labelClone]);
    expect(store.doc.nodes[labelClone].text).toBe("默认文案");
    expect(store.doc.nodes[rect.id]).toBeUndefined();

    store.undo();
    expect(store.doc.nodes[slotClone].slotFilled).toBe(true);
    expect(store.doc.nodes[slotClone].children).toEqual([rect.id]);
    expect(store.doc.nodes[rect.id]).toBeTruthy();
  });

  it("删除已填充的母版插槽被拒绝，清空后允许", () => {
    const { store, content, slotClone, rect } = setup();
    store.apply({ type: "slot.fill", params: { slotId: slotClone, nodeIds: [rect.id] } });
    const before = JSON.stringify(store.doc);
    expect(() => store.apply({ type: "node.delete", params: { nodeId: content.id } })).toThrow(/已被实例填充/);
    expect(JSON.stringify(store.doc)).toBe(before);

    store.apply({ type: "slot.clear", params: { slotId: slotClone } });
    store.apply({ type: "node.delete", params: { nodeId: content.id } });
    expect(store.doc.nodes[content.id]).toBeUndefined();
    expect(store.doc.nodes[slotClone]).toBeUndefined();
  });

  it("在未填充的实例插槽里新建节点会替换默认内容并标记已填充", () => {
    const { store, slotClone, labelClone } = setup();
    const created = createNode("rect", { name: "新建内容", x: 5, y: 5, width: 20, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [created], parentId: slotClone } });
    expect(store.doc.nodes[slotClone].slotFilled).toBe(true);
    expect(store.doc.nodes[slotClone].children).toEqual([created.id]);
    expect(store.doc.nodes[labelClone]).toBeUndefined();
    expect(store.doc.nodes[created.id].parentId).toBe(slotClone);
  });

  it("插槽名唯一、不能嵌套插槽、实例内不能创建插槽", () => {
    const { store, master, content, instanceId } = setup();
    const other = createNode("frame", { name: "其它区", x: 20, y: 20, width: 100, height: 30 });
    store.apply({ type: "node.create", params: { nodes: [other], parentId: master.id } });
    store.apply({ type: "slot.create", params: { nodeId: other.id, name: "footer" } });
    expect(() => store.apply({ type: "node.update", params: { nodeId: content.id, patch: { name: "footer" } } })).toThrow(
      /已存在/,
    );

    const wrapper = createNode("frame", { name: "包裹", x: 0, y: 0, width: 100, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [wrapper], parentId: master.id } });
    store.apply({
      type: "node.reparent",
      params: { nodeId: content.id, parentId: wrapper.id, x: 0, y: 0 },
    });
    expect(() => store.apply({ type: "slot.create", params: { nodeId: wrapper.id } })).toThrow(/不能嵌套插槽/);

    const extra = createNode("frame", { name: "额外区", x: 0, y: 0, width: 20, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [extra], parentId: master.id } });
    const extraClone = `${instanceId}:${extra.id}`;
    expect(store.doc.nodes[extraClone].type).toBe("frame");
    expect(() => store.apply({ type: "slot.create", params: { nodeId: extraClone } })).toThrow(/实例内部/);

    const outside = createNode("frame", { name: "页面画板", x: 900, y: 0, width: 50, height: 50 });
    store.apply({ type: "node.create", params: { nodes: [outside], parentId: store.doc.rootIds[0] } });
    expect(() => store.apply({ type: "slot.create", params: { nodeId: outside.id } })).toThrow(/主组件内/);
  });
});

describe("组件：属性", () => {
  function setup() {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const master = createNode("frame", {
      name: "卡片",
      width: 300,
      height: 200,
      style: { fill: { token: "color/surface" } },
    });
    store.apply({ type: "node.create", params: { nodes: [master], parentId: pageId } });
    const label = createNode("text", {
      name: "标题",
      x: 10,
      y: 10,
      width: 80,
      height: 24,
      text: "标题",
      style: { fill: { token: "color/text" } },
    });
    store.apply({ type: "node.create", params: { nodes: [label], parentId: master.id } });
    const badge = createNode("rect", {
      name: "角标",
      x: 200,
      y: 10,
      width: 40,
      height: 20,
      style: { fill: { token: "color/primary" } },
    });
    store.apply({ type: "node.create", params: { nodes: [badge], parentId: master.id } });
    store.apply({ type: "component.create", params: { nodeIds: [master.id] } });
    const instanceId = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: master.id, parentId: pageId, nodeId: instanceId, x: 400, y: 0 },
    });
    return {
      store,
      pageId,
      master,
      label,
      badge,
      instanceId,
      labelClone: `${instanceId}:${label.id}`,
      badgeClone: `${instanceId}:${badge.id}`,
    };
  }

  it("文本属性优先于母版与覆盖；清除后回落母版", () => {
    const { store, master, label, instanceId, labelClone } = setup();
    // 先制造一个文本覆盖
    store.apply({ type: "node.update", params: { nodeId: labelClone, patch: { text: "旧覆盖" } } });
    expect(store.doc.nodes[instanceId].overrides?.[label.id]?.text).toBe("旧覆盖");

    store.apply({
      type: "property.define",
      params: { componentId: master.id, targetMainId: label.id, id: "p_text", type: "text" },
    });
    // 属性创建时清掉同字段的旧覆盖，并回到母版值
    expect(store.doc.nodes[instanceId].overrides?.[label.id]).toBeUndefined();
    expect(store.doc.nodes[labelClone].text).toBe("标题");
    expect(store.doc.nodes[master.id].propertyDefs?.[0]).toMatchObject({
      id: "p_text",
      name: "标题",
      type: "text",
      targetMainId: label.id,
    });

    store.apply({ type: "property.set", params: { instanceId, propertyId: "p_text", value: "实例标题" } });
    expect(store.doc.nodes[labelClone].text).toBe("实例标题");
    expect(store.doc.nodes[instanceId].overrides?.[label.id]?.text).toBeUndefined();

    // 母版文案变了，属性值仍然优先
    store.apply({ type: "node.update", params: { nodeId: label.id, patch: { text: "新母版" } } });
    expect(store.doc.nodes[labelClone].text).toBe("实例标题");

    // 清除属性值 → 回落母版
    store.apply({ type: "property.set", params: { instanceId, propertyId: "p_text", value: null } });
    expect(store.doc.nodes[labelClone].text).toBe("新母版");

    store.undo();
    expect(store.doc.nodes[labelClone].text).toBe("实例标题");
  });

  it("布尔属性控制图层可见性", () => {
    const { store, master, badge, instanceId, badgeClone } = setup();
    store.apply({
      type: "property.define",
      params: { componentId: master.id, targetMainId: badge.id, id: "p_badge", type: "boolean" },
    });
    store.apply({ type: "property.set", params: { instanceId, propertyId: "p_badge", value: false } });
    expect(store.doc.nodes[badgeClone].visible).toBe(false);
    store.apply({ type: "property.set", params: { instanceId, propertyId: "p_badge", value: null } });
    expect(store.doc.nodes[badgeClone].visible).toBe(true);
  });

  it("属性改名保留实例值；删除属性回落母版并清掉实例值", () => {
    const { store, master, label, instanceId, labelClone } = setup();
    store.apply({
      type: "property.define",
      params: { componentId: master.id, targetMainId: label.id, id: "p_text", type: "text" },
    });
    store.apply({ type: "property.set", params: { instanceId, propertyId: "p_text", value: "实例标题" } });
    store.apply({ type: "property.rename", params: { componentId: master.id, propertyId: "p_text", name: "主标题" } });
    expect(store.doc.nodes[labelClone].text).toBe("实例标题");
    expect(store.doc.nodes[master.id].propertyDefs?.[0].name).toBe("主标题");

    store.apply({ type: "property.delete", params: { componentId: master.id, propertyId: "p_text" } });
    expect(store.doc.nodes[master.id].propertyDefs).toBeUndefined();
    expect(store.doc.nodes[instanceId].propValues).toBeUndefined();
    expect(store.doc.nodes[labelClone].text).toBe("标题");

    store.undo();
    expect(store.doc.nodes[master.id].propertyDefs?.[0].id).toBe("p_text");
    expect(store.doc.nodes[instanceId].propValues?.p_text).toBe("实例标题");
    expect(store.doc.nodes[labelClone].text).toBe("实例标题");
  });

  it("属性定义校验类型、目标与重名", () => {
    const { store, master, label, badge } = setup();
    expect(() =>
      store.apply({
        type: "property.define",
        params: { componentId: master.id, targetMainId: badge.id, id: "p1", type: "text" },
      }),
    ).toThrow(/文本图层/);
    expect(() =>
      store.apply({
        type: "property.define",
        params: { componentId: master.id, targetMainId: label.id, id: "p1", type: "instance" },
      }),
    ).toThrow(/嵌套实例/);
    store.apply({
      type: "property.define",
      params: { componentId: master.id, targetMainId: label.id, id: "p1", type: "text", name: "标题" },
    });
    expect(() =>
      store.apply({
        type: "property.define",
        params: { componentId: master.id, targetMainId: label.id, id: "p2", type: "text" },
      }),
    ).toThrow(/已经有组件属性/);
    expect(() =>
      store.apply({
        type: "property.define",
        params: { componentId: master.id, targetMainId: badge.id, id: "p2", type: "boolean", name: "标题" },
      }),
    ).toThrow(/已存在/);
  });

  it("实例替换属性切换嵌套实例，清除后回到默认组件", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];

    const bMaster = createNode("frame", { name: "B", width: 100, height: 50 });
    store.apply({ type: "node.create", params: { nodes: [bMaster], parentId: pageId } });
    const bText = createNode("text", { name: "B 文案", x: 5, y: 5, width: 40, height: 20, text: "B" });
    store.apply({ type: "node.create", params: { nodes: [bText], parentId: bMaster.id } });
    store.apply({ type: "component.create", params: { nodeIds: [bMaster.id] } });

    const cMaster = createNode("frame", { name: "C", width: 180, height: 80 });
    store.apply({ type: "node.create", params: { nodes: [cMaster], parentId: pageId } });
    const cRect = createNode("rect", { name: "C 内容", width: 60, height: 30 });
    store.apply({ type: "node.create", params: { nodes: [cRect], parentId: cMaster.id } });
    store.apply({ type: "component.create", params: { nodeIds: [cMaster.id] } });

    const aMaster = createNode("frame", { name: "A", width: 300, height: 200 });
    store.apply({ type: "node.create", params: { nodes: [aMaster], parentId: pageId } });
    store.apply({ type: "component.create", params: { nodeIds: [aMaster.id] } });
    const bInA = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: bMaster.id, parentId: aMaster.id, nodeId: bInA, x: 10, y: 10 },
    });
    store.apply({
      type: "property.define",
      params: { componentId: aMaster.id, targetMainId: bInA, id: "p_inst", type: "instance" },
    });

    const aInstance = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: aMaster.id, parentId: pageId, nodeId: aInstance, x: 500, y: 0 },
    });
    const nestedB = `${aInstance}:${bInA}`;
    expect(store.doc.nodes[nestedB].componentId).toBe(bMaster.id);
    expect(store.doc.nodes[nestedB].children).toEqual([`${nestedB}:${bText.id}`]);

    store.apply({ type: "property.set", params: { instanceId: aInstance, propertyId: "p_inst", value: cMaster.id } });
    expect(store.doc.nodes[nestedB].componentId).toBe(cMaster.id);
    expect(store.doc.nodes[nestedB].width).toBe(180);
    expect(store.doc.nodes[nestedB].height).toBe(80);
    expect(store.doc.nodes[nestedB].children).toEqual([`${nestedB}:${cRect.id}`]);

    store.apply({ type: "property.set", params: { instanceId: aInstance, propertyId: "p_inst", value: null } });
    expect(store.doc.nodes[nestedB].componentId).toBe(bMaster.id);
    expect(store.doc.nodes[nestedB].children).toEqual([`${nestedB}:${bText.id}`]);

    // 换成包含 A 的组件会形成循环
    expect(() =>
      store.apply({ type: "property.set", params: { instanceId: aInstance, propertyId: "p_inst", value: aMaster.id } }),
    ).toThrow(/循环/);
  });
});

describe("组件：属性目标删除", () => {
  it("删除母版目标图层时属性与实例值一起清理，撤销恢复", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const master = createNode("frame", { name: "卡片", width: 200, height: 120 });
    store.apply({ type: "node.create", params: { nodes: [master], parentId: pageId } });
    const label = createNode("text", { name: "标题", width: 80, height: 24, text: "标题" });
    store.apply({ type: "node.create", params: { nodes: [label], parentId: master.id } });
    store.apply({ type: "component.create", params: { nodeIds: [master.id] } });
    const instanceId = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: master.id, parentId: pageId, nodeId: instanceId, x: 300, y: 0 },
    });
    const cloneId = `${instanceId}:${label.id}`;
    store.apply({
      type: "property.define",
      params: { componentId: master.id, targetMainId: label.id, id: "p_text", type: "text" },
    });
    store.apply({ type: "property.set", params: { instanceId, propertyId: "p_text", value: "实例标题" } });

    store.apply({ type: "node.delete", params: { nodeId: label.id } });
    expect(store.doc.nodes[master.id].propertyDefs).toBeUndefined();
    expect(store.doc.nodes[instanceId].propValues).toBeUndefined();
    expect(store.doc.nodes[cloneId]).toBeUndefined();

    store.undo();
    expect(store.doc.nodes[label.id]).toBeTruthy();
    expect(store.doc.nodes[master.id].propertyDefs?.[0]?.id).toBe("p_text");
    expect(store.doc.nodes[instanceId].propValues?.p_text).toBe("实例标题");
    expect(store.doc.nodes[cloneId]?.text).toBe("实例标题");
  });
});

describe("组件：替换、脱离与删除", () => {
  function makeComponent(store: DocStore, pageId: string, name: string, w = 200, h = 100) {
    const master = createNode("frame", { name, width: w, height: h });
    store.apply({ type: "node.create", params: { nodes: [master], parentId: pageId } });
    const body = createNode("frame", { name: "body", x: 10, y: 10, width: w - 20, height: h - 20 });
    store.apply({ type: "node.create", params: { nodes: [body], parentId: master.id } });
    store.apply({ type: "component.create", params: { nodeIds: [master.id] } });
    store.apply({ type: "slot.create", params: { nodeId: body.id, name: "body" } });
    return { master, body };
  }

  function setupFilled() {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const a = makeComponent(store, pageId, "A", 200, 100);
    const c = makeComponent(store, pageId, "C", 240, 120);
    const instanceId = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: a.master.id, parentId: pageId, nodeId: instanceId, x: 400, y: 0 },
    });
    const slotClone = `${instanceId}:${a.body.id}`;
    const content = createNode("rect", { name: "内容", x: 700, y: 400, width: 50, height: 30 });
    store.apply({ type: "node.create", params: { nodes: [content], parentId: pageId } });
    store.apply({ type: "slot.fill", params: { slotId: slotClone, nodeIds: [content.id] } });
    return { store, pageId, a, c, instanceId, slotClone, content };
  }

  it("替换组件保留同名已填充插槽内容，尺寸取新组件，可撤销", () => {
    const { store, a, c, instanceId, slotClone, content } = setupFilled();
    store.apply({ type: "instance.swap", params: { instanceId, componentId: c.master.id } });

    const root = store.doc.nodes[instanceId];
    expect(root.componentId).toBe(c.master.id);
    expect(root.mainId).toBe(c.master.id);
    expect(root.width).toBe(240);
    expect(root.height).toBe(120);
    expect(root.overrides).toBeUndefined();
    expect(root.children).toEqual([slotClone]);

    const slot = store.doc.nodes[slotClone];
    expect(slot.mainId).toBe(c.body.id);
    expect(slot.slotFilled).toBe(true);
    expect(slot.children).toEqual([content.id]);
    expect(store.doc.nodes[content.id].parentId).toBe(slotClone);

    store.undo();
    expect(store.doc.nodes[instanceId].componentId).toBe(a.master.id);
    expect(store.doc.nodes[instanceId].width).toBe(200);
    expect(store.doc.nodes[slotClone].slotFilled).toBe(true);
    expect(store.doc.nodes[content.id]).toBeTruthy();
  });

  it("替换到没有同名插槽的组件时旧内容删除，撤销恢复", () => {
    const { store, pageId, instanceId, slotClone, content } = setupFilled();
    const d = createNode("frame", { name: "D", width: 120, height: 60 });
    store.apply({ type: "node.create", params: { nodes: [d], parentId: pageId } });
    store.apply({ type: "component.create", params: { nodeIds: [d.id] } });

    store.apply({ type: "instance.swap", params: { instanceId, componentId: d.id } });
    expect(store.doc.nodes[instanceId].children).toEqual([]);
    expect(store.doc.nodes[slotClone]).toBeUndefined();
    expect(store.doc.nodes[content.id]).toBeUndefined();

    store.undo();
    expect(store.doc.nodes[slotClone].slotFilled).toBe(true);
    expect(store.doc.nodes[content.id]).toBeTruthy();
  });

  it("脱离实例：根转画板、插槽转容器、空槽删除、嵌套实例保留，可撤销", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];

    // B 组件（嵌套实例用）
    const bMaster = createNode("frame", { name: "B", width: 80, height: 40 });
    store.apply({ type: "node.create", params: { nodes: [bMaster], parentId: pageId } });
    store.apply({ type: "component.create", params: { nodeIds: [bMaster.id] } });

    // A 组件：一个有内容的插槽 + 一个空插槽 + 一个 B 实例
    const aMaster = createNode("frame", { name: "A", width: 300, height: 200 });
    store.apply({ type: "node.create", params: { nodes: [aMaster], parentId: pageId } });
    const body = createNode("frame", { name: "body", x: 10, y: 10, width: 200, height: 80 });
    store.apply({ type: "node.create", params: { nodes: [body], parentId: aMaster.id } });
    const empty = createNode("frame", { name: "footer", x: 10, y: 120, width: 200, height: 50 });
    store.apply({ type: "node.create", params: { nodes: [empty], parentId: aMaster.id } });
    store.apply({ type: "component.create", params: { nodeIds: [aMaster.id] } });
    store.apply({ type: "slot.create", params: { nodeId: body.id, name: "body" } });
    store.apply({ type: "slot.create", params: { nodeId: empty.id, name: "footer" } });
    const bInA = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: bMaster.id, parentId: aMaster.id, nodeId: bInA, x: 230, y: 20 },
    });

    const instanceId = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: aMaster.id, parentId: pageId, nodeId: instanceId, x: 500, y: 0 },
    });
    const bodyClone = `${instanceId}:${body.id}`;
    const emptyClone = `${instanceId}:${empty.id}`;
    const bClone = `${instanceId}:${bInA}`;
    const user = createNode("rect", { name: "用户内容", x: 900, y: 400, width: 40, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [user], parentId: pageId } });
    store.apply({ type: "slot.fill", params: { slotId: bodyClone, nodeIds: [user.id] } });

    store.apply({ type: "component.detach", params: { instanceId } });
    const root = store.doc.nodes[instanceId];
    expect(root.type).toBe("frame");
    expect(root.componentId).toBeUndefined();
    expect(root.mainId).toBeUndefined();
    expect(root.overrides).toBeUndefined();
    expect(root.width).toBe(300);
    expect(store.doc.nodes[bodyClone].type).toBe("frame");
    expect(store.doc.nodes[bodyClone].children).toEqual([user.id]);
    expect(store.doc.nodes[emptyClone]).toBeUndefined();
    expect(store.doc.nodes[bClone].type).toBe("instance");
    expect(store.doc.nodes[bClone].componentId).toBe(bMaster.id);
    expect(store.doc.nodes[bClone].mainId).toBe(bMaster.id);

    store.undo();
    expect(store.doc.nodes[instanceId].type).toBe("instance");
    expect(store.doc.nodes[bodyClone].type).toBe("slot");
    expect(store.doc.nodes[bodyClone].slotFilled).toBe(true);
    expect(store.doc.nodes[emptyClone]).toBeTruthy();
  });

  it("删除主组件时实例自动脱离；删除含组件的页面同理", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const master = createNode("frame", { name: "A", width: 100, height: 60 });
    store.apply({ type: "node.create", params: { nodes: [master], parentId: pageId } });
    store.apply({ type: "component.create", params: { nodeIds: [master.id] } });
    const instanceId = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: master.id, parentId: pageId, nodeId: instanceId, x: 300, y: 0 },
    });

    store.apply({ type: "node.delete", params: { nodeId: master.id } });
    expect(store.doc.nodes[master.id]).toBeUndefined();
    expect(store.doc.nodes[instanceId].type).toBe("frame");
    expect(store.doc.nodes[instanceId].componentId).toBeUndefined();

    store.undo();
    expect(store.doc.nodes[master.id].type).toBe("component");
    expect(store.doc.nodes[instanceId].type).toBe("instance");
    expect(store.doc.nodes[instanceId].componentId).toBe(master.id);

    // 页面删除：组件在页面 2，实例在页面 1
    const page2 = createNode("page", { name: "页面 2", x: 3000, width: 800, height: 600 });
    store.apply({ type: "node.create", params: { nodes: [page2], parentId: null } });
    const master2 = createNode("frame", { name: "B", width: 100, height: 60 });
    store.apply({ type: "node.create", params: { nodes: [master2], parentId: page2.id } });
    store.apply({ type: "component.create", params: { nodeIds: [master2.id] } });
    const instance2 = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: master2.id, parentId: pageId, nodeId: instance2, x: 500, y: 0 },
    });

    store.apply({ type: "node.delete", params: { nodeId: page2.id } });
    expect(store.doc.nodes[page2.id]).toBeUndefined();
    expect(store.doc.nodes[instance2].type).toBe("frame");

    store.undo();
    expect(store.doc.nodes[page2.id]).toBeTruthy();
    expect(store.doc.nodes[instance2].type).toBe("instance");
  });
});

describe("组件：嵌套实例替换与覆盖作用域", () => {
  function setupNested() {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];

    const bMaster = createNode("frame", { name: "B", width: 100, height: 50 });
    store.apply({ type: "node.create", params: { nodes: [bMaster], parentId: pageId } });
    const bText = createNode("text", { name: "B 内容", text: "B", width: 40, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [bText], parentId: bMaster.id } });
    store.apply({ type: "component.create", params: { nodeIds: [bMaster.id] } });

    const cMaster = createNode("frame", { name: "C", width: 120, height: 60 });
    store.apply({ type: "node.create", params: { nodes: [cMaster], parentId: pageId } });
    const cRect = createNode("rect", { name: "C 内容", width: 60, height: 30 });
    store.apply({ type: "node.create", params: { nodes: [cRect], parentId: cMaster.id } });
    store.apply({ type: "component.create", params: { nodeIds: [cMaster.id] } });

    const aMaster = createNode("frame", { name: "A", width: 300, height: 200 });
    store.apply({ type: "node.create", params: { nodes: [aMaster], parentId: pageId } });
    store.apply({ type: "component.create", params: { nodeIds: [aMaster.id] } });
    const bInA = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: bMaster.id, parentId: aMaster.id, nodeId: bInA, x: 10, y: 10 },
    });
    const aInst = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: aMaster.id, parentId: pageId, nodeId: aInst, x: 400, y: 0 },
    });
    const nested = `${aInst}:${bInA}`;
    return { store, pageId, aMaster, bMaster, bText, cMaster, cRect, bInA, aInst, nested };
  }

  it("直接替换嵌套实例后，外层母版同步不回退、不破坏 C 的子树", () => {
    const { store, aMaster, cMaster, cRect, aInst, bInA, nested } = setupNested();
    store.apply({ type: "instance.swap", params: { instanceId: nested, componentId: cMaster.id } });
    expect(store.doc.nodes[nested].componentId).toBe(cMaster.id);

    store.apply({ type: "node.update", params: { nodeId: aMaster.id, patch: { name: "A2" } } });
    expect(store.doc.nodes[nested].componentId).toBe(cMaster.id);
    expect(store.doc.nodes[nested].width).toBe(120);
    expect(store.doc.nodes[nested].children).toEqual([`${nested}:${cRect.id}`]);
    expect(store.doc.nodes[aInst].overrides?.[bInA]?.componentId).toBe(cMaster.id);
  });

  it("实例替换属性后，外层母版同步不回退、不覆盖 C 的尺寸与子树", () => {
    const { store, aMaster, cMaster, cRect, bInA, aInst, nested } = setupNested();
    store.apply({
      type: "property.define",
      params: { componentId: aMaster.id, targetMainId: bInA, id: "p_inst", type: "instance" },
    });
    store.apply({ type: "property.set", params: { instanceId: aInst, propertyId: "p_inst", value: cMaster.id } });
    expect(store.doc.nodes[nested].componentId).toBe(cMaster.id);

    store.apply({ type: "node.update", params: { nodeId: aMaster.id, patch: { name: "A2" } } });
    expect(store.doc.nodes[nested].componentId).toBe(cMaster.id);
    expect(store.doc.nodes[nested].width).toBe(120);
    expect(store.doc.nodes[nested].children).toEqual([`${nested}:${cRect.id}`]);
  });

  it("嵌套实例的位置覆盖写入外层实例，并在外层同步时保留", () => {
    const { store, aMaster, nested, aInst, bInA } = setupNested();
    store.apply({ type: "node.update", params: { nodeId: nested, patch: { x: 50, y: 60 } } });
    expect(store.doc.nodes[aInst].overrides?.[bInA]?.x).toBe(50);
    expect(store.doc.nodes[aInst].overrides?.[bInA]?.y).toBe(60);

    store.apply({ type: "node.update", params: { nodeId: aMaster.id, patch: { name: "A2" } } });
    expect(store.doc.nodes[nested].x).toBe(50);
    expect(store.doc.nodes[nested].y).toBe(60);
  });

  it("嵌套实例的尺寸覆盖写入自身，并在外层同步/母版变化时保留", () => {
    const { store, aMaster, bMaster, nested } = setupNested();
    store.apply({ type: "node.update", params: { nodeId: nested, patch: { width: 140, height: 70 } } });
    expect(store.doc.nodes[nested].overrides?.[store.doc.nodes[nested].componentId!]?.width).toBe(140);

    store.apply({ type: "node.update", params: { nodeId: aMaster.id, patch: { name: "A2" } } });
    expect(store.doc.nodes[nested].width).toBe(140);
    expect(store.doc.nodes[nested].height).toBe(70);

    store.apply({ type: "node.update", params: { nodeId: bMaster.id, patch: { width: 90, height: 45 } } });
    expect(store.doc.nodes[nested].width).toBe(140);
    expect(store.doc.nodes[nested].height).toBe(70);
  });

  it("重置嵌套实例的 componentId 覆盖会换回外层母版组件，撤销恢复", () => {
    const { store, bMaster, bText, cMaster, cRect, aInst, bInA, nested } = setupNested();
    store.apply({ type: "instance.swap", params: { instanceId: nested, componentId: cMaster.id } });
    store.apply({
      type: "instance.resetOverride",
      params: { instanceId: aInst, mainId: bInA, fields: ["componentId"] },
    });
    expect(store.doc.nodes[nested].componentId).toBe(bMaster.id);
    expect(store.doc.nodes[nested].children).toEqual([`${nested}:${bText.id}`]);
    expect(store.doc.nodes[aInst].overrides?.[bInA]?.componentId).toBeUndefined();

    store.undo();
    expect(store.doc.nodes[nested].componentId).toBe(cMaster.id);
    expect(store.doc.nodes[nested].children).toEqual([`${nested}:${cRect.id}`]);
  });

  it("componentId 被属性绑定时拒绝直接替换", () => {
    const { store, aMaster, cMaster, bInA, nested } = setupNested();
    store.apply({
      type: "property.define",
      params: { componentId: aMaster.id, targetMainId: bInA, id: "p_inst", type: "instance" },
    });
    expect(() =>
      store.apply({ type: "instance.swap", params: { instanceId: nested, componentId: cMaster.id } }),
    ).toThrow(/属性|实例不存在/);
  });
});

describe("组件：插槽插入与实例内容保护", () => {
  it("instance.create 进入未填充插槽时清默认、置 filled，并在母版同步后保留", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const master = createNode("frame", { name: "A", width: 200, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [master], parentId: pageId } });
    const slot = createNode("slot", { name: "body", x: 10, y: 10, width: 180, height: 80 });
    store.apply({ type: "node.create", params: { nodes: [slot], parentId: master.id } });
    const def = createNode("text", { name: "默认", text: "默认", width: 40, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [def], parentId: slot.id } });
    store.apply({ type: "component.create", params: { nodeIds: [master.id] } });
    const inst = createNode("instance").id;
    store.apply({ type: "instance.create", params: { componentId: master.id, parentId: pageId, nodeId: inst, x: 300, y: 0 } });
    const slotClone = `${inst}:${slot.id}`;
    const defClone = `${slotClone}:${def.id}`;

    const b = createNode("frame", { name: "B", width: 50, height: 50 });
    store.apply({ type: "node.create", params: { nodes: [b], parentId: pageId } });
    store.apply({ type: "component.create", params: { nodeIds: [b.id] } });
    const child = createNode("instance").id;
    store.apply({ type: "instance.create", params: { componentId: b.id, parentId: slotClone, nodeId: child, x: 0, y: 0 } });

    expect(store.doc.nodes[slotClone].slotFilled).toBe(true);
    expect(store.doc.nodes[slotClone].children).toEqual([child]);
    expect(store.doc.nodes[defClone]).toBeUndefined();

    store.apply({ type: "node.update", params: { nodeId: master.id, patch: { name: "A2" } } });
    expect(store.doc.nodes[slotClone].children).toEqual([child]);
    expect(store.doc.nodes[child]).toBeTruthy();

    store.undo(); // 撤销母版重命名
    store.undo(); // 撤销插槽插入
    expect(store.doc.nodes[child]).toBeUndefined();
    expect(store.doc.nodes[slotClone].slotFilled).toBeUndefined();
    expect(store.doc.nodes[slotClone].children).toEqual([defClone]);
  });

  it("实例内容不能创建组件；顶层实例本身可以整体包组件", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const master = createNode("frame", { name: "A", width: 200, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [master], parentId: pageId } });
    const text = createNode("text", { name: "T", text: "hi", width: 40, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [text], parentId: master.id } });
    store.apply({ type: "component.create", params: { nodeIds: [master.id] } });
    const inst = createNode("instance").id;
    store.apply({ type: "instance.create", params: { componentId: master.id, parentId: pageId, nodeId: inst, x: 300, y: 0 } });
    const clone = `${inst}:${text.id}`;
    const before = JSON.stringify(store.doc);
    expect(() =>
      store.apply({
        type: "component.create",
        params: { nodeIds: [clone], componentId: createNode("component").id },
      }),
    ).toThrow(/实例内部/);
    expect(JSON.stringify(store.doc)).toBe(before);

    const wrapper = createNode("component").id;
    store.apply({ type: "component.create", params: { nodeIds: [inst], componentId: wrapper } });
    expect(store.doc.nodes[wrapper].children).toEqual([inst]);
    expect(store.doc.nodes[inst].type).toBe("instance");
  });
});

describe("自动布局：命令层写回", () => {
  function setup() {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const frame = createNode("frame", { name: "F", width: 300, height: 200 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    const a = createNode("rect", { name: "A", width: 100, height: 50 });
    const b = createNode("rect", { name: "B", width: 50, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [a], parentId: frame.id } });
    store.apply({ type: "node.create", params: { nodes: [b], parentId: frame.id } });
    return { store, pageId, frame, a, b };
  }

  it("添加布局后按 padding/gap 排布，撤销回到原状", () => {
    const { store, frame, a, b } = setup();
    const before = { ax: a.x, ay: a.y, bx: b.x, by: b.y };
    store.apply({
      type: "node.update",
      params: {
        nodeId: frame.id,
        patch: {
          layout: createLayoutSpec({
            direction: "horizontal",
            gap: 10,
            padding: { top: 5, right: 5, bottom: 5, left: 5 },
          }),
        },
      },
    });
    expect(store.doc.nodes[a.id]).toMatchObject({ x: 5, y: 5 });
    expect(store.doc.nodes[b.id]).toMatchObject({ x: 115, y: 5 });
    store.undo();
    expect(store.doc.nodes[a.id]).toMatchObject({ x: before.ax, y: before.ay });
    expect(store.doc.nodes[b.id]).toMatchObject({ x: before.bx, y: before.by });
  });

  it("hug 容器宽度由内容决定，fill 子项撑满剩余空间", () => {
    const { store, frame, a } = setup();
    store.apply({
      type: "node.update",
      params: {
        nodeId: frame.id,
        patch: { layoutSizingW: "hug", layoutSizingH: "hug", layout: createLayoutSpec({ direction: "vertical", gap: 4 }) },
      },
    });
    expect(store.doc.nodes[frame.id].width).toBe(100);
    expect(store.doc.nodes[frame.id].height).toBe(74);

    store.apply({ type: "node.update", params: { nodeId: a.id, patch: { layoutSizingW: "fill" } } });
    expect(store.doc.nodes[a.id].width).toBe(100);
  });

  it("隐藏子项退出排布，绝对定位子项保持自身坐标", () => {
    const { store, frame, a, b } = setup();
    store.apply({ type: "node.update", params: { nodeId: b.id, patch: { x: 33, y: 44, layoutAbsolute: true } } });
    store.apply({
      type: "node.update",
      params: { nodeId: frame.id, patch: { layout: createLayoutSpec({ direction: "vertical", gap: 10 }) } },
    });
    expect(store.doc.nodes[b.id]).toMatchObject({ x: 33, y: 44 });
    expect(store.doc.nodes[a.id]).toMatchObject({ x: 0, y: 0 });

    store.apply({ type: "node.update", params: { nodeId: a.id, patch: { visible: false } } });
    store.apply({ type: "node.update", params: { nodeId: a.id, patch: { visible: true, height: 50 } } });
    expect(store.doc.nodes[a.id]).toMatchObject({ x: 0, y: 0 });
  });

  it("重排复用 node.reparent，并触发重新求解", () => {
    const { store, frame, a, b } = setup();
    store.apply({
      type: "node.update",
      params: { nodeId: frame.id, patch: { layout: createLayoutSpec({ direction: "horizontal", gap: 10 }) } },
    });
    expect(store.doc.nodes[b.id].x).toBe(110);
    store.apply({ type: "node.reparent", params: { nodeId: b.id, parentId: frame.id, index: 0 } });
    expect(store.doc.nodes[b.id].x).toBe(0);
    expect(store.doc.nodes[a.id].x).toBe(60);
  });
});

describe("拖拽换父级：命令层", () => {
  it("多根批量 reparent 到布局画板：索引连续、求解生效、一次撤销", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const target = createNode("frame", { name: "目标", width: 300, height: 200 });
    store.apply({ type: "node.create", params: { nodes: [target], parentId: pageId } });
    store.apply({
      type: "node.update",
      params: { nodeId: target.id, patch: { layout: createLayoutSpec({ direction: "horizontal", gap: 10 }) } },
    });
    const a = createNode("rect", { name: "A", width: 40, height: 20 });
    const b = createNode("rect", { name: "B", width: 40, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [a], parentId: pageId } });
    store.apply({ type: "node.create", params: { nodes: [b], parentId: pageId } });

    store.apply(
      [
        { type: "node.reparent", params: { nodeId: a.id, parentId: target.id, index: 0 } },
        { type: "node.reparent", params: { nodeId: b.id, parentId: target.id, index: 1 } },
      ],
      "move",
    );
    expect(store.doc.nodes[target.id].children).toEqual([a.id, b.id]);
    expect(store.doc.nodes[a.id]).toMatchObject({ x: 0, y: 0 });
    expect(store.doc.nodes[b.id]).toMatchObject({ x: 50, y: 0 });

    store.undo();
    expect(store.doc.nodes[target.id].children).toEqual([]);
    expect(store.doc.nodes[a.id].parentId).toBe(pageId);
    expect(store.doc.nodes[b.id].parentId).toBe(pageId);
  });

  it("跨页面 reparent 保留世界坐标，撤销回到原父级", () => {
    const store = new DocStore(createEmptyDoc());
    const page1 = store.doc.rootIds[0];
    const page2 = createNode("page", { name: "页面 2", x: 2000, width: 800, height: 600 });
    store.apply({ type: "node.create", params: { nodes: [page2], parentId: null } });
    const frame = createNode("frame", { x: 100, y: 50, width: 200, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: page1 } });
    const child = createNode("rect", { x: 10, y: 20, width: 30, height: 30 });
    store.apply({ type: "node.create", params: { nodes: [child], parentId: frame.id } });

    const before = worldRect(store.doc, child.id)!;
    store.apply({
      type: "node.reparent",
      params: { nodeId: child.id, parentId: page2.id, x: before.x - page2.x, y: before.y - page2.y },
    });
    expect(store.doc.nodes[child.id].parentId).toBe(page2.id);
    expect(worldRect(store.doc, child.id)).toMatchObject({ x: before.x, y: before.y });

    store.undo();
    expect(store.doc.nodes[child.id].parentId).toBe(frame.id);
    expect(worldRect(store.doc, child.id)).toMatchObject({ x: before.x, y: before.y });
  });
});

describe("锁定：命令入口校验", () => {
  function setup() {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const frame = createNode("frame", { name: "锁定组", width: 200, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    const child = createNode("rect", { name: "子项", width: 50, height: 50 });
    store.apply({ type: "node.create", params: { nodes: [child], parentId: frame.id } });
    store.apply({ type: "node.update", params: { nodeId: frame.id, patch: { locked: true } } });
    return { store, pageId, frame, child };
  }

  it("锁定节点的自身与后代都不能改、不能删、不能移", () => {
    const { store, frame, child } = setup();
    expect(() =>
      store.apply({ type: "node.update", params: { nodeId: child.id, patch: { width: 10 } } }),
    ).toThrow(/锁定/);
    expect(() => store.apply({ type: "node.delete", params: { nodeId: child.id } })).toThrow(/锁定/);
    expect(() =>
      store.apply({ type: "node.create", params: { nodes: [createNode("rect")], parentId: frame.id } }),
    ).toThrow(/锁定/);
    expect(() =>
      store.apply({ type: "node.reparent", params: { nodeId: child.id, parentId: store.doc.rootIds[0] } }),
    ).toThrow(/锁定/);
  });

  it("解锁后恢复编辑；撤销仍然可用", () => {
    const { store, frame } = setup();
    store.apply({ type: "node.update", params: { nodeId: frame.id, patch: { locked: false } } });
    expect(store.doc.nodes[frame.id].locked).toBe(false);
    store.apply({ type: "node.update", params: { nodeId: frame.id, patch: { width: 240 } } });
    expect(store.doc.nodes[frame.id].width).toBe(240);
    store.undo();
    expect(store.doc.nodes[frame.id].width).toBe(200);
  });
});

describe("迁移：formatVersion 1 → 2", () => {
  it("归一化 padding / cornerRadius / 文本字段，并保持旧文档不裁剪", () => {
    const page = createNode("page", { width: 800, height: 600 });
    const frame = createNode("frame", {
      width: 200,
      height: 100,
      clip: undefined as unknown as boolean,
      style: { cornerRadius: 8 as unknown as never },
      layout: { direction: "vertical", gap: 4, padding: 12 as unknown as never, mainAlign: "start", crossAlign: "start" } as never,
    });
    const text = createNode("text", { width: 50, height: 20, text: "hi", style: { lineHeight: 2 } });
    const state: DocState = {
      version: 1,
      rootIds: [page.id],
      nodes: { [page.id]: { ...page, children: [frame.id] }, [frame.id]: { ...frame, children: [text.id] }, [text.id]: text },
      tokens: {},
    };
    migrateDoc(state as never, 1);
    expect(state.formatVersion).toBe(2);
    const f = state.nodes[frame.id];
    expect(f.layout?.padding).toEqual({ top: 12, right: 12, bottom: 12, left: 12 });
    expect(f.layout?.wrap).toBe(false);
    expect(f.style.cornerRadius).toEqual({ topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 });
    expect(f.clip).toBe(false);
    const t = state.nodes[text.id];
    expect(t.textAutoResize).toBe("auto-width");
    expect(t.listType).toBe("none");
    expect(t.style.lineHeight).toBeUndefined();
    const snapshot = JSON.stringify(state);
    migrateDoc(state as never, 2);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe("文本行盒", () => {
  const measure = (text: string) => [...text].length * 10;

  it("按宽度换行、列表缩进与段落间距", () => {
    const layout = layoutText("ab cd\n第二段", { fontSize: 10, paragraphSpacing: 4 }, {
      measure,
      listType: "bulleted",
      maxWidth: 50,
    });
    expect(layout.lines.length).toBeGreaterThanOrEqual(3);
    expect(layout.lines[0].marker).toBe("•");
    expect(layout.lines[0].indent).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(layout.lines.length * 14);
  });

  it("fixed 高度 + truncate 生成省略号", () => {
    const layout = layoutText("aa bb cc dd ee", { fontSize: 10 }, {
      measure,
      maxWidth: 30,
      maxHeight: 15,
      truncate: true,
    });
    expect(layout.truncated).toBe(true);
    expect(layout.lines.at(-1)?.text.endsWith("…")).toBe(true);
  });

  it("行高与字距单位换算", () => {
    expect(lineHeightPx({ fontSize: 10, lineHeight: 20, lineHeightUnit: "px" })).toBe(20);
    expect(lineHeightPx({ fontSize: 10, lineHeight: 200, lineHeightUnit: "percent" })).toBe(20);
    expect(lineHeightPx({ fontSize: 10, lineHeightUnit: "auto" })).toBeCloseTo(14);
    expect(letterSpacingPx({ fontSize: 10, letterSpacing: 20, letterSpacingUnit: "percent" })).toBe(2);
  });
});

describe("自动布局：实例覆盖", () => {
  it("实例改布局只影响自己，并写入覆盖表", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const master = createNode("frame", {
      name: "卡片",
      width: 200,
      height: 120,
      layout: createLayoutSpec({ direction: "horizontal", gap: 8 }),
    });
    store.apply({ type: "node.create", params: { nodes: [master], parentId: pageId } });
    const child = createNode("rect", { name: "内容", width: 40, height: 20 });
    store.apply({ type: "node.create", params: { nodes: [child], parentId: master.id } });
    store.apply({ type: "component.create", params: { nodeIds: [master.id] } });
    const instId = createNode("instance").id;
    store.apply({
      type: "instance.create",
      params: { componentId: master.id, parentId: pageId, nodeId: instId, x: 300, y: 0 },
    });
    const cloneId = `${instId}:${child.id}`;
    expect(store.doc.nodes[cloneId].x).toBe(0);

    store.apply({
      type: "node.update",
      params: { nodeId: instId, patch: { layout: createLayoutSpec({ direction: "horizontal", gap: 40 }) } },
    });
    expect(store.doc.nodes[master.id].layout?.gap).toBe(8);
    expect(store.doc.nodes[cloneId].x).toBe(0);
    expect(store.doc.nodes[instId].overrides?.[master.id]?.layout).toBeTruthy();

    store.undo();
    expect(store.doc.nodes[instId].overrides?.[master.id]?.layout).toBeFalsy();
  });
});

describe("布局：尺寸安全与 stretch 语义", () => {
  const base = createLayoutSpec({ direction: "horizontal", gap: 10 });

  it("空间不足时 fill 子项不会得到负宽度", () => {
    const r = solveLayout(
      base,
      [
        { id: "fixed", width: 200, height: 20, sizingW: "fixed", sizingH: "fixed" },
        { id: "fill", width: 0, height: 20, sizingW: "fill", sizingH: "fixed" },
      ],
      100,
      100,
    );
    expect(r.items.find((i) => i.id === "fill")?.width).toBe(0);
  });

  it("stretch 不覆盖 hug / 文本自动尺寸", () => {
    const r = solveLayout(
      { ...base, crossAlign: "stretch" },
      [
        { id: "hug", width: 50, height: 20, sizingW: "fixed", sizingH: "fixed", hugH: true },
        { id: "stretch", width: 50, height: 20, sizingW: "fixed", sizingH: "fixed" },
      ],
      300,
      100,
    );
    expect(r.items.find((i) => i.id === "hug")?.height).toBe(20);
    expect(r.items.find((i) => i.id === "stretch")?.height).toBe(100);
  });
});

describe("新建容器的默认自动布局", () => {
  it("只给 frame / component 默认值，createNode 本身保持纯净", () => {
    expect(defaultLayoutFor("frame")).toMatchObject({
      direction: "vertical",
      gap: 10,
      padding: { top: 10, right: 10, bottom: 10, left: 10 },
    });
    expect(defaultLayoutFor("component")?.gap).toBe(10);
    expect(defaultLayoutFor("rect")).toBeUndefined();
    expect(createNode("frame").layout).toBeUndefined();
  });

  it("每次返回独立副本，改一个不影响另一个", () => {
    const a = defaultLayoutFor("frame")!;
    a.gap = 99;
    a.padding.left = 99;
    const b = defaultLayoutFor("frame")!;
    expect(b.gap).toBe(10);
    expect(b.padding.left).toBe(10);
  });
});

describe("worldQuad：几何覆盖", () => {
  it("覆盖节点局部矩形时仍累加祖先偏移", () => {
    const page = createNode("page", { x: 100, y: 50, width: 800, height: 600 });
    const frame = createNode("frame", { x: 20, y: 10, width: 200, height: 200 });
    const child = createNode("rect", { x: 10, y: 10, width: 50, height: 50 });
    frame.children = [child.id];
    child.parentId = frame.id;
    page.children = [frame.id];
    frame.parentId = page.id;
    const state = { version: 1, rootIds: [page.id], nodes: { [page.id]: page, [frame.id]: frame, [child.id]: child }, tokens: {} };
    const quad = worldQuad(state, child.id, { x: 30, y: 20, width: 60, height: 40 });
    expect(quad?.[0]).toEqual({ x: 150, y: 80 });
    expect(quad?.[2]).toEqual({ x: 210, y: 120 });
  });
});

describe("applyDerived：派生几何白名单", () => {
  it("只允许写回几何，不进入撤销栈", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = store.doc.rootIds[0];
    const rect = createNode("rect", { width: 100, height: 100 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const undoBefore = store.canUndo;
    store.applyDerived({ type: "node.update", params: { nodeId: rect.id, patch: { height: 60 } } });
    expect(store.doc.nodes[rect.id].height).toBe(60);
    expect(store.canUndo).toBe(undoBefore);
    expect(() =>
      store.applyDerived({ type: "node.update", params: { nodeId: rect.id, patch: { style: rect.style } } }),
    ).toThrow(/只允许/);
    expect(() =>
      store.applyDerived({ type: "node.update", params: { nodeId: rect.id, patch: { text: "x" } } }),
    ).toThrow(/只允许/);
  });
});

describe("节点效果", () => {
  const shadow = {
    type: "drop-shadow" as const,
    visible: true,
    x: 0,
    y: 4,
    blur: 12,
    spread: 0,
    color: { value: "#0f172a29" },
  };

  it("效果随样式整体替换，一次编辑一步撤销", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = firstPageId(store.doc)!;
    const rect = createNode("rect", { parentId: pageId, style: { fill: { token: "color/primary" } } });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });

    store.apply({
      type: "node.update",
      params: { nodeId: rect.id, patch: { style: { ...rect.style, effects: [shadow] } } },
    });
    expect(store.doc.nodes[rect.id].style.effects).toEqual([shadow]);

    // 第二层效果：整组替换，而不是合并
    store.apply({
      type: "node.update",
      params: {
        nodeId: rect.id,
        patch: { style: { ...store.doc.nodes[rect.id].style, effects: [shadow, { ...shadow, y: 20 }] } },
      },
    });
    expect(store.doc.nodes[rect.id].style.effects).toHaveLength(2);

    store.undo();
    expect(store.doc.nodes[rect.id].style.effects).toEqual([shadow]);
    store.undo();
    expect(store.doc.nodes[rect.id].style.effects).toBeUndefined();
    store.redo();
    expect(store.doc.nodes[rect.id].style.effects).toEqual([shadow]);
  });

  it("效果不改包围盒，也不出现在命中几何里", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = firstPageId(store.doc)!;
    const rect = createNode("rect", { parentId: pageId, x: 40, y: 50, width: 120, height: 80 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const before = worldRect(store.doc, rect.id);
    store.apply({
      type: "node.update",
      params: { nodeId: rect.id, patch: { style: { ...rect.style, effects: [shadow] } } },
    });
    expect(worldRect(store.doc, rect.id)).toEqual(before);
  });

  it("序列化往返保留效果，旧文档缺字段读入为无效果", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = firstPageId(store.doc)!;
    const rect = createNode("rect", { parentId: pageId, style: { effects: [shadow] } });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const round = migrateDoc(JSON.parse(JSON.stringify(store.doc)));
    expect(round.nodes[rect.id].style.effects).toEqual([shadow]);

    const legacy = JSON.parse(JSON.stringify(store.doc));
    delete legacy.nodes[rect.id].style.effects;
    expect(migrateDoc(legacy).nodes[rect.id].style.effects).toBeUndefined();
  });

  it("外扩距离随投影/模糊累加，内阴影与背景模糊不外扩", () => {
    expect(effectPadding(undefined)).toBe(0);
    expect(effectPadding([])).toBe(0);
    expect(effectPadding([{ ...shadow, visible: false }])).toBe(0);
    // 12 * BLUR_EXTENT(3) + |(0,4)| = 40
    expect(effectPadding([shadow])).toBe(40);
    // 可见扩散实测 ≈ 2.2×blur，外扩必须盖住它，否则投影软边会被硬切
    for (const blur of [1, 10, 40, 100]) {
      expect(effectPadding([{ ...shadow, blur, y: 0, x: 0 }])).toBeGreaterThanOrEqual(blur * 2.2);
    }
    expect(effectPadding([{ type: "inner-shadow", visible: true, x: 0, y: 4, blur: 12, spread: 0, color: { value: "#000" } }])).toBe(0);
    expect(effectPadding([{ type: "backdrop-blur", visible: true, radius: 20 }])).toBe(0);
    expect(effectPadding([{ type: "layer-blur", visible: true, radius: 10 }])).toBe(30);
    // 多条累加
    expect(effectPadding([shadow, { type: "layer-blur", visible: true, radius: 10 }])).toBe(70);
  });

  it("离屏倍率在长边超上限时降采样", () => {
    expect(effectLayerScale(100, 100, 2, 2048)).toBe(2);
    // 2000 * 2 = 4000 > 2048 → 2048 / 2000
    expect(effectLayerScale(2000, 100, 2, 2048)).toBeCloseTo(1.024, 5);
  });

  it("效果数值被夹取：负模糊归零、非法值回退默认", () => {
    expect(sanitizeEffect({ type: "layer-blur", visible: true, radius: -5 } as never)).toEqual({
      type: "layer-blur",
      visible: true,
      radius: 0,
    });
    expect(sanitizeEffect({ ...shadow, blur: Number.NaN } as never)).toMatchObject({ blur: 0 });
  });

  it("新加效果带默认参数且默认可见", () => {
    expect(createEffect("drop-shadow")).toMatchObject({ type: "drop-shadow", visible: true, y: 4 });
    expect(createEffect("layer-blur")).toMatchObject({ type: "layer-blur", radius: 8 });
    expect(EFFECT_TYPES).toHaveLength(4);
  });
});

describe("子树绘制包围盒", () => {
  it("并入溢出子节点与旋转外接框", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = firstPageId(store.doc)!;
    const frame = createNode("frame", { parentId: pageId, x: 100, y: 100, width: 200, height: 100, clip: false });
    const overflow = createNode("rect", {
      parentId: frame.id,
      x: 180,
      y: 80,
      width: 100,
      height: 60,
      rotation: 45,
    });
    store.apply({ type: "node.create", params: { nodes: [frame], parentId: pageId } });
    store.apply({ type: "node.create", params: { nodes: [overflow], parentId: frame.id } });

    const box = subtreeWorldBounds(store.doc, frame.id)!;
    // 容器本身
    expect(box.x).toBe(100);
    expect(box.y).toBe(100);
    // 子节点溢出：世界坐标 (280,180) + 100×60，旋转 45° 后外接框右/下边界 ≈ 386.5 / 266.5
    expect(box.x + box.width).toBeGreaterThan(386);
    expect(box.y + box.height).toBeGreaterThan(266);
  });

  it("把效果外扩算进去", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = firstPageId(store.doc)!;
    const withShadow = createNode("rect", {
      parentId: pageId,
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      style: { effects: [{ type: "drop-shadow", visible: true, x: 0, y: 0, blur: 20, spread: 0, color: { value: "#000" } }] },
    });
    store.apply({ type: "node.create", params: { nodes: [withShadow], parentId: pageId } });
    const box = subtreeWorldBounds(store.doc, withShadow.id)!;
    // pad = 20 * 3 = 60
    expect(box).toEqual({ x: 40, y: 40, width: 220, height: 220 });
  });

  it("无子节点的节点退化为自身矩形（含效果外扩）", () => {
    const store = new DocStore(createEmptyDoc());
    const pageId = firstPageId(store.doc)!;
    const rect = createNode("rect", {
      parentId: pageId,
      x: 10,
      y: 20,
      width: 50,
      height: 40,
      style: { effects: [{ type: "layer-blur", visible: true, radius: 8 }] },
    });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    const box = subtreeWorldBounds(store.doc, rect.id)!;
    expect(box).toEqual({ x: -14, y: -4, width: 98, height: 88 });
  });
});

describe("脏标记", () => {
  function withRect() {
    const store = new DocStore(createEmptyDoc());
    const pageId = firstPageId(store.doc)!;
    const rect = createNode("rect", { parentId: pageId, x: 0, y: 0, width: 10, height: 10 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    return { store, rect };
  }

  it("apply 后变脏，markSaved 后干净，undo/redo 各自重新变脏", () => {
    const { store } = withRect();
    expect(store.isDirty).toBe(true);
    store.markSaved();
    expect(store.isDirty).toBe(false);
    store.undo();
    expect(store.isDirty).toBe(true);
    store.redo();
    expect(store.isDirty).toBe(false);
  });

  it("打开文件（replace）后视为干净", () => {
    const { store } = withRect();
    store.replace(createEmptyDoc());
    expect(store.isDirty).toBe(false);
  });

  it("派生几何写回不算脏（自动高度不应让文件立刻变脏）", () => {
    const { store, rect } = withRect();
    store.markSaved();
    store.applyDerived({ type: "node.update", params: { nodeId: rect.id, patch: { height: 24 } } });
    expect(store.isDirty).toBe(false);
  });
});

describe("事务", () => {
  function seed(store: DocStore) {
    const pageId = firstPageId(store.doc)!;
    const rect = createNode("rect", { parentId: pageId, x: 0, y: 0, width: 10, height: 10 });
    store.apply({ type: "node.create", params: { nodes: [rect], parentId: pageId } });
    return { pageId, rect };
  }

  it("多条命令合并成一条撤销记录，撤销后全部消失", async () => {
    const store = new DocStore(createEmptyDoc());
    const { pageId } = seed(store);
    const a = createNode("rect", { parentId: pageId, x: 0, y: 0, width: 10, height: 10 });
    const b = createNode("rect", { parentId: pageId, x: 20, y: 0, width: 10, height: 10 });
    await store.transact("批量建", () => {
      store.apply({ type: "node.create", params: { nodes: [a], parentId: pageId } });
      store.apply({ type: "node.create", params: { nodes: [b], parentId: pageId } });
    });
    expect(store.doc.nodes[a.id]).toBeDefined();
    expect(store.doc.nodes[b.id]).toBeDefined();
    store.undo();
    expect(store.doc.nodes[a.id]).toBeUndefined();
    expect(store.doc.nodes[b.id]).toBeUndefined();
    // 只剩 seed 那一步
    expect(store.undoLabel).toBe("edit");
  });

  it("异常时回滚已执行的命令，且不留撤销记录", async () => {
    const store = new DocStore(createEmptyDoc());
    const { rect } = seed(store);
    await expect(
      store.transact("会失败", () => {
        store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { x: 50 } } });
        store.apply({ type: "node.update", params: { nodeId: rect.id, patch: { width: 200 } } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.doc.nodes[rect.id].x).toBe(0);
    expect(store.doc.nodes[rect.id].width).toBe(10);
    expect(store.undoLabel).toBe("edit");
  });

  it("嵌套事务并入最外层，只产生一条记录", async () => {
    const store = new DocStore(createEmptyDoc());
    const { pageId } = seed(store);
    const a = createNode("rect", { parentId: pageId, x: 0, y: 0, width: 10, height: 10 });
    const b = createNode("rect", { parentId: pageId, x: 30, y: 0, width: 10, height: 10 });
    await store.transact("外", async () => {
      store.apply({ type: "node.create", params: { nodes: [a], parentId: pageId } });
      await store.transact("内", () => {
        store.apply({ type: "node.create", params: { nodes: [b], parentId: pageId } });
      });
    });
    expect(store.doc.nodes[b.id]).toBeDefined();
    store.undo();
    expect(store.doc.nodes[a.id]).toBeUndefined();
    expect(store.doc.nodes[b.id]).toBeUndefined();
  });

  it("提交后脏标记生效", async () => {
    const store = new DocStore(createEmptyDoc());
    const { pageId } = seed(store);
    store.markSaved();
    const a = createNode("rect", { parentId: pageId, x: 0, y: 0, width: 10, height: 10 });
    await store.transact("一步", () => {
      store.apply({ type: "node.create", params: { nodes: [a], parentId: pageId } });
    });
    expect(store.isDirty).toBe(true);
    store.undo();
    expect(store.isDirty).toBe(false);
  });

  it("提交后再通知一次订阅者，脏标记才不会漏报", async () => {
    const store = new DocStore(createEmptyDoc());
    const { pageId } = seed(store);
    store.markSaved();
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.isDirty));
    const a = createNode("rect", { parentId: pageId, x: 0, y: 0, width: 10, height: 10 });
    await store.transact("一步", () => {
      store.apply({ type: "node.create", params: { nodes: [a], parentId: pageId } });
    });
    // 命令执行中的那次通知发生在提交之前，必须还有一次在提交之后
    expect(seen.at(-1)).toBe(true);
  });
});
