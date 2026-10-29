import { describe, expect, it } from "vitest";
import {
  createEmptyDoc,
  createNode,
  resolvePaint,
  worldRect,
  nextPagePosition,
  DEFAULT_PAGE_WIDTH,
  PAGE_GAP,
} from "../src/model";
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
import { clampSides, hitPolygon, polygonPoints } from "../src/polygon";

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
  const base = { direction: "horizontal", gap: 10, padding: 0, mainAlign: "start", crossAlign: "start" } as const;

  it("横向排列：固定项按序排布", () => {
    const r = solveLayout(
      { ...base },
      [
        { id: "a", width: 100, height: 50, sizingW: "fixed", sizingH: "fixed" },
        { id: "b", width: 200, height: 80, sizingW: "fixed", sizingH: "fixed" },
      ],
      1000,
      500,
    );
    expect(r).toEqual([
      { id: "a", x: 0, y: 0, width: 100, height: 50 },
      { id: "b", x: 110, y: 0, width: 200, height: 80 },
    ]);
  });

  it("fill 子项均分剩余主轴空间", () => {
    const r = solveLayout(
      { ...base },
      [
        { id: "a", width: 100, height: 50, sizingW: "fixed", sizingH: "fixed" },
        { id: "b", width: 0, height: 50, sizingW: "fill", sizingH: "fixed" },
        { id: "c", width: 0, height: 50, sizingW: "fill", sizingH: "fixed" },
      ],
      310,
      100,
    );
    expect(r[1]).toEqual({ id: "b", x: 110, y: 0, width: 95, height: 50 });
    expect(r[2]).toEqual({ id: "c", x: 215, y: 0, width: 95, height: 50 });
  });

  it("交叉轴居中与 end 对齐", () => {
    const r = solveLayout(
      { ...base, crossAlign: "center" },
      [{ id: "a", width: 100, height: 50, sizingW: "fixed", sizingH: "fixed" }],
      200,
      100,
    );
    expect(r[0].y).toBe(25);
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
    expect(r[1].x).toBe(150);
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
