/**
 * 渲染器：每帧从 DocumentStore 拉取当前状态，绘制全部页面（无限画布），
 * 容器坐标通过 pushTransform/popTransform 累加（子节点相对父容器）。
 * 渲染层无文档缓存（architecture.md §5）。
 */

import type { DocNode, DocState, NodeId } from "@sqraft/core";
import { resolvePaint } from "@sqraft/core";
import type { RenderBackend, RenderContext, Viewport } from "./backend";

const CONTAINER_TYPES = new Set(["page", "frame", "group"]);

function drawSelf(backend: RenderBackend, ctx: RenderContext, node: DocNode, isRootChild: boolean): void {
  const fill = resolvePaint(ctx.doc, node.style.fill);
  const stroke = resolvePaint(ctx.doc, node.style.stroke);
  switch (node.type) {
    case "rect":
    case "component":
      backend.drawRect(node, fill, stroke, node.style.strokeWidth, node.style.cornerRadius ?? 0);
      break;
    case "frame":
      backend.drawRect(node, "#ffffff", "rgba(0,0,0,0.12)", 1, node.style.cornerRadius ?? 0, true);
      if (isRootChild) backend.drawFrameOutline(node);
      break;
    case "ellipse":
      backend.drawEllipse(node, fill, stroke, node.style.strokeWidth);
      break;
    case "line":
      backend.drawLine(node, stroke ?? "#000", node.style.strokeWidth ?? 1);
      break;
    case "text":
      backend.drawText(node, fill ?? "#000");
      break;
    case "instance":
      backend.drawRect(node, fill ?? "transparent", "rgba(79,70,229,0.6)", 1, node.style.cornerRadius ?? 0);
      break;
    default:
      if (!CONTAINER_TYPES.has(node.type)) {
        backend.drawRect(node, fill, stroke, node.style.strokeWidth, node.style.cornerRadius ?? 0);
      }
  }
}

/** 把渲染几何替换为拖动预览（resize）或偏移（move）。 */
function geometryOf(node: DocNode, options: DrawOptions): { x: number; y: number; width: number; height: number } {
  const resize = options.resizePreview;
  if (resize && resize.id === node.id) {
    return { x: resize.x, y: resize.y, width: resize.width, height: resize.height };
  }
  const preview = options.movePreview;
  if (preview && preview.ids.includes(node.id)) {
    return { x: node.x + preview.dx, y: node.y + preview.dy, width: node.width, height: node.height };
  }
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

function drawNode(
  backend: RenderBackend,
  ctx: RenderContext,
  node: DocNode,
  isRootChild: boolean,
  options: DrawOptions,
): void {
  if (!node.visible) return;
  const geo = geometryOf(node, options);
  const changed = geo.x !== node.x || geo.y !== node.y || geo.width !== node.width || geo.height !== node.height;
  // 行内编辑中的文本由 DOM 输入框承载，画布上跳过以免重影
  if (node.id !== options.hideTextId) {
    drawSelf(backend, ctx, changed ? { ...node, ...geo } : node, isRootChild);
  }
  if (node.children.length > 0) {
    backend.pushTransform(geo.x, geo.y);
    for (const childId of node.children) {
      const child = ctx.doc.nodes[childId];
      if (child) drawNode(backend, ctx, child, false, options);
    }
    backend.popTransform();
  }
}

export interface DrawOptions {
  /** 跳过该节点的自绘（用于文本行内编辑时隐藏原文字）。 */
  hideTextId?: NodeId;
  /** 拖动中的渲染期预览：命中的"移动根"整体偏移，不改文档。 */
  movePreview?: { ids: readonly NodeId[]; dx: number; dy: number };
  /** 缩放中的渲染期预览：命中的节点用给定几何绘制。 */
  resizePreview?: { id: NodeId; x: number; y: number; width: number; height: number };
  /** 需要淡化的页面（编辑模式下的非活动页）。 */
  dimPageIds?: readonly NodeId[];
}

/** 绘制所有页面与内容（不含帧生命周期，便于宿主插入背景网格）。 */
export function drawDocument(backend: RenderBackend, doc: DocState, options: DrawOptions = {}): void {
  const ctx: RenderContext = {
    doc,
    resolveColor: (p) => resolvePaint(doc, p),
  };
  for (const pageId of doc.rootIds) {
    const page = doc.nodes[pageId];
    if (!page) continue;
    const dimmed = Boolean(options.dimPageIds?.includes(pageId));
    if (dimmed) backend.pushOpacity(0.35);
    const geo = geometryOf(page, options);
    // 页面 = 画布上的白色画板（带柔和投影）
    backend.drawRect(
      geo.x !== page.x || geo.y !== page.y || geo.width !== page.width || geo.height !== page.height
        ? { ...page, ...geo }
        : page,
      "#ffffff",
      "rgba(15,23,42,0.10)",
      1,
      0,
      true,
    );
    backend.pushTransform(geo.x, geo.y);
    for (const childId of page.children) {
      const child = doc.nodes[childId];
      if (child) drawNode(backend, ctx, child, true, options);
    }
    backend.popTransform();
    if (dimmed) backend.popOpacity();
  }
}

export function renderDocument(backend: RenderBackend, doc: DocState, vp: Viewport): void {
  backend.beginFrame(vp);
  drawDocument(backend, doc);
  backend.endFrame();
}

export type { NodeId };
