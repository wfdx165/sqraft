/**
 * 写入后诊断：对改动子树跑一组纯函数检查。
 *
 * 纪律：
 * - 只警告，不产生命令、不回滚、不进撤销栈（见 docs/specs/agent-diagnostics.md）；
 * - 文本度量由调用方注入，core 不碰 DOM；
 * - 结果只依赖 doc + measure，确定性可测。
 */

import {
  resolvePaint,
  worldQuad,
  type DocNode,
  type DocState,
  type NodeId,
  type Rect,
  type WorldPoint,
} from "./model";
import { layoutText, type MeasureText } from "./text";
import { tokenPathsOfNode } from "./token-fields";
import { resolveNumericLayout, resolveNumericStyle } from "./token-resolve";

export type DiagnosticCode = "ZERO_SIZE" | "TEXT_NO_FILL" | "TEXT_OVERFLOW" | "TOKEN_MISSING" | "OUTSIDE_PARENT";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "warning";
  nodeId: NodeId;
  nodeName: string;
  /** 名称链：顶层归属（页面 / 组件母版）→ 父节点，不含自己 */
  path: string[];
  /** 英文一行（agent 面文案） */
  message: string;
  /** 英文，可执行建议 */
  hint: string;
}

export interface DiagnoseOptions {
  /** 文本度量；不传则跳过 TEXT_OVERFLOW */
  measure?: MeasureText;
  /** 只跑这些码（Token 命令只有文档级改动时只跑 TOKEN_MISSING） */
  codes?: readonly DiagnosticCode[];
  /**
   * 只检查给定根节点自身，不下探子树。
   *
   * 写工具用：`changed` 已经包含每个被动的节点（node.create / instance.create 会把每个新节点加进去，
   * 布局回写会把被重排的子项加进去），再下探只会把父容器里的历史问题重报一遍。
   * `inspect_layout` / 截图文本视图保持默认的整棵子树扫描。
   */
  shallow?: boolean;
  /** 最多扫描多少节点，默认 2000 */
  maxNodes?: number;
  /** 最多返回多少条，默认 20 */
  maxDiagnostics?: number;
}

export interface DiagnoseResult {
  diagnostics: Diagnostic[];
  /** 有节点没扫到，或有诊断没输出 */
  truncated: boolean;
}

const DEFAULT_MAX_NODES = 2000;
const DEFAULT_MAX_DIAGNOSTICS = 20;
/** 几何容差：0.5px 内的越界不算 */
const EPS = 0.5;

function quadRect(points: WorldPoint[] | null): Rect | null {
  if (!points || points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 只判断「完全不挨着」：部分伸出父边界是常态，不算问题。 */
function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width + EPS < b.x ||
    b.x + b.width + EPS < a.x ||
    a.y + a.height + EPS < b.y ||
    b.y + b.height + EPS < a.y
  );
}

/** 名称链：顶层归属 → 父节点（不含自己）。 */
function namesPathOf(doc: DocState, id: NodeId): string[] {
  const names: string[] = [];
  let cur: NodeId | null = doc.nodes[id]?.parentId ?? null;
  while (cur) {
    const node: DocNode | undefined = doc.nodes[cur];
    if (!node) break;
    names.push(node.name);
    cur = node.parentId;
  }
  return names.reverse();
}

/** 父容器内容区：有布局时内缩已解析的 padding，否则就是父的世界包围盒。 */
function contentBoxOf(doc: DocState, parent: DocNode): Rect | null {
  const box = quadRect(worldQuad(doc, parent.id));
  if (!box) return null;
  if (!parent.layout) return box;
  const layout = resolveNumericLayout(doc, parent.layout);
  const padding = layout.padding;
  const width = box.width - padding.left - padding.right;
  const height = box.height - padding.top - padding.bottom;
  // 内容区被 padding 吃没：没法判断，宁可不报
  if (width <= 0 || height <= 0) return null;
  return { x: box.x + padding.left, y: box.y + padding.top, width, height };
}

/** 去掉祖先已在集合里的根，保持调用方给的顺序。 */
function topRoots(doc: DocState, roots: NodeId[]): NodeId[] {
  const set = new Set(roots.filter((id) => Boolean(doc.nodes[id])));
  const out: NodeId[] = [];
  for (const id of set) {
    let included = false;
    let cur = doc.nodes[id]?.parentId ?? null;
    while (cur) {
      if (set.has(cur)) {
        included = true;
        break;
      }
      cur = doc.nodes[cur]?.parentId ?? null;
    }
    if (!included) out.push(id);
  }
  return out;
}

export function diagnose(doc: DocState, roots: NodeId[], options: DiagnoseOptions = {}): DiagnoseResult {
  const maxNodes = Math.max(1, options.maxNodes ?? DEFAULT_MAX_NODES);
  const maxDiagnostics = Math.max(1, options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS);
  const measure = options.measure;
  const codes = options.codes ? new Set(options.codes) : null;
  const want = (code: DiagnosticCode): boolean => !codes || codes.has(code);
  const diagnostics: Diagnostic[] = [];
  let truncated = false;
  let scanned = 0;

  const baseOf = (node: DocNode) => ({
    severity: "warning" as const,
    nodeId: node.id,
    nodeName: node.name,
    path: namesPathOf(doc, node.id),
  });

  /** 返回 false 表示预算用完，整趟扫描立刻停。 */
  const emit = (diagnostic: Diagnostic): boolean => {
    if (diagnostics.length >= maxDiagnostics) {
      truncated = true;
      return false;
    }
    diagnostics.push(diagnostic);
    return true;
  };

  const visit = (node: DocNode): boolean => {
    // 隐藏节点连同子树跳过，也不占扫描预算
    if (!node.visible) return true;
    if (scanned >= maxNodes) {
      truncated = true;
      return false;
    }
    scanned += 1;

    if (
      want("ZERO_SIZE") &&
      node.type !== "page" &&
      node.type !== "line" &&
      !node.vector &&
      (node.width <= 0 || node.height <= 0)
    ) {
      if (
        !emit({
          ...baseOf(node),
          code: "ZERO_SIZE",
          message: `"${node.name}" has zero or negative size (${node.width}×${node.height}).`,
          hint: "Give it a positive width and height, or remove it.",
        })
      ) {
        return false;
      }
    }

    const text = node.text ?? "";
    if (node.type === "text" && text.trim() !== "") {
      if (want("TEXT_NO_FILL") && resolvePaint(doc, node.style.fill) === undefined) {
        if (
          !emit({
            ...baseOf(node),
            code: "TEXT_NO_FILL",
            message: `Text "${node.name}" has no fill; it will render black.`,
            hint: "Set style.fill (or fillToken) to the intended text color.",
          })
        ) {
          return false;
        }
      }
      if (want("TEXT_OVERFLOW") && measure && node.textAutoResize === "fixed" && node.truncate !== true) {
        const layout = layoutText(text, resolveNumericStyle(doc, node.style), {
          measure,
          listType: node.listType,
          maxWidth: node.width,
        });
        const overflow = Math.max(layout.height - node.height, layout.width - node.width);
        if (overflow > EPS) {
          if (
            !emit({
              ...baseOf(node),
              code: "TEXT_OVERFLOW",
              message: `Text "${node.name}" overflows its box by ${Math.ceil(overflow)}px and is silently clipped.`,
              hint: 'Increase the height, switch textAutoResize to "auto-height", shorten the text, or set truncate:true if clipping is intended.',
            })
          ) {
            return false;
          }
        }
      }
    }

    if (want("TOKEN_MISSING")) {
      for (const path of tokenPathsOfNode(node)) {
        if (doc.tokens[path]) continue;
        if (
          !emit({
            ...baseOf(node),
            code: "TOKEN_MISSING",
            message: `Token "${path}" is not defined.`,
            hint: "Use get_tokens to list defined tokens, or replace the reference with a literal value.",
          })
        ) {
          return false;
        }
      }
    }

    const parent = node.parentId ? doc.nodes[node.parentId] : null;
    // 组的包围盒只在建组时算一次、之后可能过期，拿它判断会误报
    if (want("OUTSIDE_PARENT") && parent && parent.type !== "group" && parent.visible) {
      const selfBox = quadRect(worldQuad(doc, node.id));
      const area = contentBoxOf(doc, parent);
      if (selfBox && area && !rectsIntersect(selfBox, area)) {
        if (
          !emit({
            ...baseOf(node),
            code: "OUTSIDE_PARENT",
            message: `"${node.name}" is completely outside its parent "${parent.name}".`,
            hint: "Move it into the parent's content area, or check the coordinates you used.",
          })
        ) {
          return false;
        }
      }
    }

    if (options.shallow) return true;
    for (const childId of node.children) {
      const child: DocNode | undefined = doc.nodes[childId];
      if (child && !visit(child)) return false;
    }
    return true;
  };

  // shallow 时每个根都要单独查（它们可能互为祖先）；深扫时先去重，只留最外层
  const rootIds = options.shallow
    ? roots.filter((id) => Boolean(doc.nodes[id]))
    : topRoots(doc, roots);
  for (const rootId of rootIds) {
    const node = doc.nodes[rootId];
    if (node && !visit(node)) break;
  }
  return { diagnostics, truncated };
}
