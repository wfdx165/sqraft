/**
 * 视口剔除用的根节点包围盒（ADR-0032）。
 *
 * 剔除只在**根节点**（页面 / 主组件）这一级做：根节点之间互不嵌套、数量与节点总数无关，
 * 一个根整棵子树与视口不相交就整块跳过，子树内部仍按原样逐节点绘制。
 *
 * 包围盒必须是**保守**的——宁可多画也不能把看得见的内容剔掉：
 * 旋转按四角变换、效果按 pad 外扩（与 `subtreeWorldBounds` 同一口径）、描边按整条宽度外扩，
 * 文本再按自身高度外扩一次（固定尺寸的文本框可能溢出）。隐藏节点也计入（便宜且安全）。
 */

import type { DocNode, DocState, NodeId, Rect } from "@sqraft/core";
import { effectPadding, resolveNumericStyle } from "@sqraft/core";

/** 2D 仿射矩阵 [a, b, c, d, e, f]：x' = a·x + c·y + e，y' = b·x + d·y + f */
type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** 节点本地坐标 → 父坐标：平移到 (x, y)，再绕自身中心旋转（与 `worldQuad` 一致）。 */
function localToParent(node: DocNode): Matrix {
  const angle = ((node.rotation || 0) * Math.PI) / 180;
  if (!angle) return [1, 0, 0, 1, node.x, node.y];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  // T(cx, cy) · R · T(-w/2, -h/2)
  const hx = -node.width / 2;
  const hy = -node.height / 2;
  return [cos, sin, -sin, cos, cx + cos * hx - sin * hy, cy + sin * hx + cos * hy];
}

/** 节点超出自身矩形的保守外扩量（文档单位）。 */
function overflowPad(doc: DocState, node: DocNode): number {
  const style = resolveNumericStyle(doc, node.style);
  let pad = effectPadding(style.effects) + Math.max(0, style.strokeWidth ?? 0);
  if (node.type === "text") pad += Math.max(node.height, (style.fontSize ?? 16) * 2);
  return pad;
}

/**
 * 根节点整棵子树的世界坐标包围盒（保守），单次自顶向下遍历，O(子树节点数)。
 * 根不存在时返回 null。
 */
export function rootDrawBounds(doc: DocState, rootId: NodeId): Rect | null {
  const root = doc.nodes[rootId];
  if (!root) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const stack: Array<{ node: DocNode; parent: Matrix }> = [{ node: root, parent: IDENTITY }];
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    const m = multiply(parent, localToParent(node));
    const pad = overflowPad(doc, node);
    const w = node.width;
    const h = node.height;
    for (const [lx, ly] of [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ] as const) {
      const x = m[0] * lx + m[2] * ly + m[4];
      const y = m[1] * lx + m[3] * ly + m[5];
      if (x - pad < minX) minX = x - pad;
      if (y - pad < minY) minY = y - pad;
      if (x + pad > maxX) maxX = x + pad;
      if (y + pad > maxY) maxY = y + pad;
    }
    for (const id of node.children) {
      const child = doc.nodes[id];
      if (child) stack.push({ node: child, parent: m });
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/**
 * 根节点包围盒缓存：由宿主（画布）持有，按「文档对象 + `version`」失效。
 *
 * 渲染器本身仍然无状态于文档（architecture.md §5）；这个缓存只存派生几何，
 * 任何一条命令、撤销/重做都会让 `version` 变化，`replace` 会换掉文档对象，两者都整体失效。
 * 拖动 / 缩放等渲染期预览不改文档，由 `drawDocument` 把受影响的根排除在剔除之外。
 */
export function createRootBoundsCache(): (doc: DocState, rootId: NodeId) => Rect | null {
  let cachedDoc: DocState | null = null;
  let cachedVersion = -1;
  let bounds = new Map<NodeId, Rect | null>();
  return (doc, rootId) => {
    if (doc !== cachedDoc || doc.version !== cachedVersion) {
      cachedDoc = doc;
      cachedVersion = doc.version;
      bounds = new Map();
    }
    if (bounds.has(rootId)) return bounds.get(rootId)!;
    const b = rootDrawBounds(doc, rootId);
    bounds.set(rootId, b);
    return b;
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
