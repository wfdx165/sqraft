/**
 * 布尔运算与转路径的命令规划：操作数校验、形状 → 轮廓、展开成基础命令。
 *
 * 几何在 `boolean.ts`（纯函数）；这里只回答"选了什么、结果该是什么样式与位置"。
 * 所有计算在命令展开期完成，`apply` 期只写结果（不变式 2）。
 */

import { lockedChain } from "./arrange";
import { booleanContours, type BooleanOp } from "./boolean";
import { findInstanceAncestor } from "./component";
import { AppError } from "./errors";
import { createNode, cornerRadiusOf, type DocNode, type DocState, type NodeId } from "./model";
import { clampSides, polygonPoints } from "./polygon";
import type { Command } from "./store";
import type { FillRule, VectorAnchor, VectorContour, VectorPath } from "./vector";

/** 贝塞尔近似四分之一圆的控制柄长度。 */
const KAPPA = 0.5522847498;

const BOOLEAN_TYPES: ReadonlySet<string> = new Set(["path", "rect", "ellipse", "polygon", "line"]);
const CONVERT_TYPES: ReadonlySet<string> = new Set(["rect", "ellipse", "polygon", "line"]);

export interface BooleanCommandParams {
  nodeIds: NodeId[];
  /** 结果节点 id：命令创建前由调用方分配（不变式 2） */
  resultId: NodeId;
}

export interface BooleanSelection {
  /** 去重后的操作数（按图层顺序，底层在前） */
  operands: DocNode[];
  /** 样式、名字、父级与图层位置的来源 */
  baseline: DocNode;
}

export function booleanOpOf(type: Command["type"]): BooleanOp {
  switch (type) {
    case "boolean.union":
      return "union";
    case "boolean.subtract":
      return "subtract";
    case "boolean.intersect":
      return "intersect";
    case "boolean.exclude":
      return "exclude";
    default:
      throw new Error(`不是布尔命令：${type}`);
  }
}

/**
 * 校验并解释一次布尔选择：支持的类型、同一父级、未锁定、至少两个、不在实例内部。
 * `subtract` 的基准层是最底层，其余取最上层（Figma 语义）。
 *
 * 单独导出是因为 agent 需要在执行前后回答"样式来自谁"（`styleFrom`）。
 * GUI 的右键菜单也用它预判可用性，所以守卫放在这里（实例内部直接置灰）。
 */
export function inspectBooleanSelection(doc: DocState, nodeIds: readonly NodeId[], op: BooleanOp): BooleanSelection {
  const ids = [...new Set(nodeIds)];
  if (ids.length < 2) throw new AppError("core.boolean.single");
  const nodes: DocNode[] = [];
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) throw new Error(`节点 ${id} 不存在`);
    if (!BOOLEAN_TYPES.has(node.type)) throw new AppError("core.boolean.unsupportedType", { name: node.name });
    if (lockedChain(doc, id)) throw new AppError("core.boolean.locked", { name: node.name });
    // 布尔会新建/删除节点，实例内部的子树由母版同步，override 表达不了这种结构变化
    if (findInstanceAncestor(doc, id)) throw new AppError("core.boolean.instanceInterior", { name: node.name });
    nodes.push(node);
  }
  const parentId = nodes[0].parentId;
  if (!parentId || nodes.some((node) => node.parentId !== parentId)) throw new AppError("core.boolean.crossParent");
  const parent = doc.nodes[parentId];
  if (!parent) throw new AppError("core.boolean.crossParent");
  const operands = [...nodes].sort((a, b) => parent.children.indexOf(a.id) - parent.children.indexOf(b.id));
  const baseline = op === "subtract" ? operands[0] : operands[operands.length - 1];
  return { operands, baseline };
}

/* ---------- 形状 → 轮廓（节点本地坐标，不含 rotation / x / y） ---------- */

function closeAnchors(points: Array<{ x: number; y: number }>): VectorAnchor[] {
  const anchors: VectorAnchor[] = [];
  for (const point of points) {
    const last = anchors[anchors.length - 1];
    if (last && Math.abs(last.x - point.x) < 1e-9 && Math.abs(last.y - point.y) < 1e-9) continue;
    anchors.push({ x: point.x, y: point.y, inX: 0, inY: 0, outX: 0, outY: 0 });
  }
  return anchors;
}

/** 圆角矩形：四角各自按圆弧转贝塞尔；半径为 0 的角保持尖角。 */
function roundedRectContour(node: DocNode): VectorContour {
  const w = Math.max(1, node.width);
  const h = Math.max(1, node.height);
  const max = Math.min(w, h) / 2;
  const radius = cornerRadiusOf(node.style);
  const handle = (r: number) => KAPPA * Math.min(Math.max(0, r), max);
  const tl = Math.min(Math.max(0, radius.topLeft ?? 0), max);
  const tr = Math.min(Math.max(0, radius.topRight ?? 0), max);
  const br = Math.min(Math.max(0, radius.bottomRight ?? 0), max);
  const bl = Math.min(Math.max(0, radius.bottomLeft ?? 0), max);
  const anchors: VectorAnchor[] = [];
  const push = (anchor: VectorAnchor) => {
    const last = anchors[anchors.length - 1];
    if (last && Math.abs(last.x - anchor.x) < 1e-9 && Math.abs(last.y - anchor.y) < 1e-9) {
      // 同一点的两个角（例如 0 尺寸）合并手柄
      last.outX = anchor.outX;
      last.outY = anchor.outY;
      return;
    }
    anchors.push(anchor);
  };
  const anchor = (x: number, y: number, patch: Partial<VectorAnchor> = {}): VectorAnchor => ({
    x,
    y,
    inX: 0,
    inY: 0,
    outX: 0,
    outY: 0,
    ...patch,
  });

  if (tl > 0) {
    const k = handle(tl);
    push(anchor(0, tl, { outX: 0, outY: -k }));
    push(anchor(tl, 0, { inX: -k, inY: 0 }));
  } else {
    push(anchor(0, 0));
  }
  if (tr > 0) {
    const k = handle(tr);
    push(anchor(w - tr, 0, { outX: k, outY: 0 }));
    push(anchor(w, tr, { inX: 0, inY: -k }));
  } else {
    push(anchor(w, 0));
  }
  if (br > 0) {
    const k = handle(br);
    push(anchor(w, h - br, { outX: 0, outY: k }));
    push(anchor(w - br, h, { inX: k, inY: 0 }));
  } else {
    push(anchor(w, h));
  }
  if (bl > 0) {
    const k = handle(bl);
    push(anchor(bl, h, { outX: -k, outY: 0 }));
    push(anchor(0, h - bl, { inX: 0, inY: k }));
  } else {
    push(anchor(0, h));
  }
  return { closed: true, anchors };
}

function ellipseContour(node: DocNode): VectorContour {
  const rx = Math.max(1, node.width) / 2;
  const ry = Math.max(1, node.height) / 2;
  const cx = rx;
  const cy = ry;
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  return {
    closed: true,
    anchors: [
      { x: cx + rx, y: cy, inX: 0, inY: -ky, outX: 0, outY: ky },
      { x: cx, y: cy + ry, inX: kx, inY: 0, outX: -kx, outY: 0 },
      { x: cx - rx, y: cy, inX: 0, inY: ky, outX: 0, outY: -ky },
      { x: cx, y: cy - ry, inX: -kx, inY: 0, outX: kx, outY: 0 },
    ],
  };
}

/** 节点本地坐标下的轮廓；不支持的类型返回 null。path 返回已有轮廓的副本。 */
export function shapeContours(node: DocNode): VectorContour[] | null {
  switch (node.type) {
    case "path":
      return node.vector
        ? node.vector.contours.map((c) => ({ closed: c.closed, anchors: c.anchors.map((a) => ({ ...a })) }))
        : null;
    case "rect":
      return [roundedRectContour(node)];
    case "ellipse":
      return [ellipseContour(node)];
    case "polygon":
      return [{ closed: true, anchors: closeAnchors(polygonPoints(clampSides(node.sides), node.width, node.height)) }];
    case "line":
      if (node.vector) return node.vector.contours.map((c) => ({ closed: c.closed, anchors: c.anchors.map((a) => ({ ...a })) }));
      return [
        {
          closed: false,
          anchors: [
            { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
            { x: node.width, y: node.height, inX: 0, inY: 0, outX: 0, outY: 0 },
          ],
        },
      ];
    default:
      return null;
  }
}

/** 把节点自己的旋转烘焙进轮廓，再平移到父容器坐标（布尔在同一父级内进行）。 */
function contoursInParent(node: DocNode): VectorContour[] {
  const contours = shapeContours(node);
  if (!contours) throw new AppError("core.boolean.unsupportedType", { name: node.name });
  const rad = (node.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = node.width / 2;
  const cy = node.height / 2;
  return contours.map((contour) => ({
    closed: contour.closed,
    anchors: contour.anchors.map((a) => {
      const dx = a.x - cx;
      const dy = a.y - cy;
      const point = {
        x: node.x + cx + dx * cos - dy * sin,
        y: node.y + cy + dx * sin + dy * cos,
      };
      const rotateHandle = (hx: number, hy: number) => ({
        x: hx * cos - hy * sin,
        y: hx * sin + hy * cos,
      });
      const out = rotateHandle(a.outX, a.outY);
      const into = rotateHandle(a.inX, a.inY);
      return { ...point, outX: out.x, outY: out.y, inX: into.x, inY: into.y };
    }),
  }));
}

/* ---------- 展开 ---------- */

export function expandBoolean(doc: DocState, op: BooleanOp, params: BooleanCommandParams): Command[] {
  const { operands, baseline } = inspectBooleanSelection(doc, params.nodeIds, op);
  if (doc.nodes[params.resultId]) throw new Error(`节点 ${params.resultId} 已存在`);
  const parentId = baseline.parentId;
  if (!parentId) throw new AppError("core.boolean.crossParent");
  const parent = doc.nodes[parentId];
  const contours = booleanContours(
    operands.map((node) => contoursInParent(node)),
    op,
  );
  const result = createNode("path", {
    id: params.resultId,
    name: baseline.name,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    rotation: 0,
    opacity: baseline.opacity,
    visible: baseline.visible,
    vector: { contours, fillRule: "evenodd" },
    style: structuredClone(baseline.style),
    layoutSizingW: baseline.layoutSizingW,
    layoutSizingH: baseline.layoutSizingH,
    layoutAbsolute: baseline.layoutAbsolute,
  });
  const index = parent.children.indexOf(baseline.id) + 1;
  return [
    { type: "node.create", params: { nodes: [result], parentId, index } },
    ...operands.map((node) => ({ type: "node.delete" as const, params: { nodeId: node.id } })),
  ];
}

/** 形状 → 路径：原地换类型，id / 样式 / 父级 / 层级都不变（ADR-0040 决策 7）。 */
export function expandConvertToPath(doc: DocState, params: { nodeIds: NodeId[] }): Command[] {
  const out: Command[] = [];
  for (const id of [...new Set(params.nodeIds)]) {
    const node = doc.nodes[id];
    if (!node) throw new Error(`节点 ${id} 不存在`);
    if (node.type === "path") continue;
    if (!CONVERT_TYPES.has(node.type)) throw new AppError("core.convert.unsupportedType", { name: node.name });
    if (lockedChain(doc, id)) throw new AppError("core.convert.locked", { name: node.name });
    // 同布尔：实例内部的类型变化写不进 override，会被下次母版同步冲掉
    if (findInstanceAncestor(doc, id)) throw new AppError("core.convert.instanceInterior", { name: node.name });
    const contours = shapeContours(node);
    if (!contours) throw new AppError("core.convert.unsupportedType", { name: node.name });
    const vector: VectorPath = { contours, fillRule: "nonzero" as FillRule };
    out.push({
      type: "node.update",
      params: { nodeId: id, patch: { type: "path", vector, sides: undefined } },
    });
  }
  return out;
}
