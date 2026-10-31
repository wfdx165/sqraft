/**
 * 渲染器：每帧从 DocumentStore 拉取当前状态，绘制全部页面（无限画布），
 * 容器坐标通过 pushTransform/popTransform 累加（子节点相对父容器）。
 * 渲染层无文档缓存（architecture.md §5）。
 */

import type { DocNode, DocState, Effect, NodeId, Rect, VectorPath } from "@sqraft/core";
import {
  cornerRadiusOf,
  imageCropOf,
  maskPlan,
  resolvePaint,
  polygonPoints,
  subtreeWorldBounds,
} from "@sqraft/core";
import type { RenderBackend, RenderContext, RenderEffect, ResolvedImage, Viewport } from "./backend";

const CONTAINER_TYPES = new Set(["page", "frame", "group"]);

function drawSelf(
  backend: RenderBackend,
  ctx: RenderContext,
  node: DocNode,
  vectorOverride?: VectorPath,
  options?: { mask?: boolean },
): void {
  const fill = resolvePaint(ctx.doc, node.style.fill);
  // 蒙版只取形状的填充：描边会让"裁出来的边"多出一圈，和 Figma 不一致
  const stroke = options?.mask ? undefined : resolvePaint(ctx.doc, node.style.stroke);
  switch (node.type) {
    // 画板、矩形、组件、实例、插槽共用同一套样式规则：有填充才画底色
    case "frame":
    case "rect":
    case "component":
    case "instance":
    case "slot":
      backend.drawRect(node, fill, stroke, node.style.strokeWidth, cornerRadiusOf(node.style));
      break;
    case "ellipse":
      backend.drawEllipse(node, fill, stroke, node.style.strokeWidth);
      break;
    case "line":
      if (node.vector) backend.drawPath(node, node.vector, undefined, stroke ?? "#000", node.style.strokeWidth ?? 1);
      else backend.drawLine(node, stroke ?? "#000", node.style.strokeWidth ?? 1);
      break;
    case "text":
      backend.drawText(node, fill ?? "#000", stroke);
      break;
    case "path": {
      const vector = vectorOverride ?? node.vector;
      if (vector) backend.drawPath(node, vector, fill, stroke, node.style.strokeWidth ?? 1);
      break;
    }
    case "polygon":
      backend.drawPolygon(node, polygonPoints(node.sides, node.width, node.height), fill, stroke, node.style.strokeWidth ?? 1);
      break;
    case "image": {
      const ref = node.image;
      const resolved = ref
        ? ref.assetId
          ? ctx.resolveImage(ref.assetId)
          : ref.sourceUrl
            ? ctx.resolveLinkedImage(ref.sourceUrl)
            : null
        : null;
      if (resolved && ref) {
        // 链接图首次抓取前 `naturalWidth` 为 0：用解码尺寸当整图范围，别把图裁成 1×1
        backend.drawImage(node, resolved, imageCropOf(node, resolved), cornerRadiusOf(node.style));
      } else {
        // 资源没带过来或还没解码完：画占位，别让画布出现"什么都没有"的空洞
        backend.drawImagePlaceholder(node, cornerRadiusOf(node.style));
      }
      break;
    }
    default:
      if (!CONTAINER_TYPES.has(node.type)) {
        backend.drawRect(node, fill, stroke, node.style.strokeWidth, cornerRadiusOf(node.style));
      }
  }
}

/** 把渲染几何替换为拖动预览（resize）、布局让位（geometry）或偏移（move）。 */
function geometryOf(node: DocNode, options: DrawOptions): { x: number; y: number; width: number; height: number } {
  const layout = options.geometryPreview?.get(node.id);
  if (layout) return { x: layout.x, y: layout.y, width: layout.width, height: layout.height };
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

/** 把可见效果解析成可绘制形式（颜色由渲染器解析，后端不认识 Token）。 */
function resolveEffects(ctx: RenderContext, effects: readonly Effect[] | undefined): RenderEffect[] {
  if (!effects || effects.length === 0) return [];
  const out: RenderEffect[] = [];
  for (const effect of effects) {
    if (!effect.visible) continue;
    if (effect.type === "drop-shadow" || effect.type === "inner-shadow") {
      const color = resolvePaint(ctx.doc, effect.color);
      if (!color) continue;
      out.push({ ...effect, color });
    } else if (effect.type === "layer-blur" || effect.type === "backdrop-blur") {
      out.push(effect);
    }
  }
  return out;
}

/**
 * 组不透明度层的包围盒：子树包围盒 + 渲染期预览带来的位移/尺寸增量。
 * 预览是渲染期几何覆盖，包围盒必须跟着走；宁可扩一圈也不要把内容裁掉。
 */
function opacityLayerBounds(
  doc: DocState,
  node: DocNode,
  geo: { x: number; y: number; width: number; height: number },
  options: DrawOptions,
): Rect | undefined {
  const base = subtreeWorldBounds(doc, node.id);
  if (!base) return undefined;
  const moveX = options.movePreview ? Math.abs(options.movePreview.dx) : 0;
  const moveY = options.movePreview ? Math.abs(options.movePreview.dy) : 0;
  const spreadX = Math.abs(geo.x - node.x) + Math.abs(geo.width - node.width) + moveX;
  const spreadY = Math.abs(geo.y - node.y) + Math.abs(geo.height - node.height) + moveY;
  if (!spreadX && !spreadY) return base;
  return {
    x: base.x - spreadX,
    y: base.y - spreadY,
    width: base.width + spreadX * 2,
    height: base.height + spreadY * 2,
  };
}

/**
 * 绘制一组兄弟节点。`isMask` 的节点不单独出现：它用自己的形状（填充 alpha）
 * 裁掉后一位兄弟，被遮罩的节点整体进离屏再合成。配对规则在 core 的 `maskPlan`。
 */
function drawChildren(
  backend: RenderBackend,
  ctx: RenderContext,
  children: readonly NodeId[],
  options: DrawOptions,
): void {
  for (const entry of maskPlan(children, (id) => ctx.doc.nodes[id]?.isMask === true)) {
    if (entry.kind === "plain") {
      const node = ctx.doc.nodes[entry.id];
      if (node) drawNode(backend, ctx, node, options);
      continue;
    }
    const mask = ctx.doc.nodes[entry.maskId];
    const target = ctx.doc.nodes[entry.targetId];
    // 蒙版或目标缺失/隐藏：整对跳过（蒙版本身不单独出现，与 Figma 一致）
    if (!mask || !target || !mask.visible || !target.visible) continue;
    backend.pushMaskLayer(subtreeWorldBounds(ctx.doc, target.id) ?? undefined);
    drawNode(backend, ctx, target, options);
    backend.popMaskLayer(
      () => drawSelf(backend, ctx, mask, undefined, { mask: true }),
      mask.opacity ?? 1,
    );
  }
}

function drawNode(
  backend: RenderBackend,
  ctx: RenderContext,
  node: DocNode,
  options: DrawOptions,
): void {
  if (!node.visible) return;
  const opacity = node.opacity ?? 1;
  const geo = geometryOf(node, options);
  const changed = geo.x !== node.x || geo.y !== node.y || geo.width !== node.width || geo.height !== node.height;
  const target = changed ? { ...node, ...geo } : node;
  // 不透明度在外、效果在内：先按组合成，再施加效果，最后整体乘 alpha
  if (opacity < 1) backend.pushOpacity(opacity, opacityLayerBounds(ctx.doc, node, geo, options));
  // 效果层包住自绘与整棵子树：先合成，再施加效果（ADR-0018）
  const effects = resolveEffects(ctx, node.style.effects);
  if (effects.length > 0) backend.pushEffects(target, effects);
  // 行内编辑中的文本由 DOM 输入框承载，画布上跳过以免重影
  if (node.id !== options.hideTextId && node.id !== options.hidePathId) {
    const vectorOverride =
      options.vectorPreview && options.vectorPreview.id === node.id ? options.vectorPreview.vector : undefined;
    drawSelf(backend, ctx, target, vectorOverride);
  }
  if (node.children.length > 0) {
    backend.pushTransform(geo.x, geo.y, node.rotation, geo.width, geo.height);
    const clipped = node.clip && (node.type === "frame" || node.type === "component" || node.type === "instance");
    if (clipped) backend.pushClip(0, 0, geo.width, geo.height, cornerRadiusOf(node.style));
    drawChildren(backend, ctx, node.children, options);
    if (clipped) backend.popClip();
    backend.popTransform();
  }
  if (effects.length > 0) backend.popEffects();
  if (opacity < 1) backend.popOpacity();
}

export interface DrawOptions {
  /** 跳过该节点的自绘（用于文本行内编辑时隐藏原文字）。 */
  hideTextId?: NodeId;
  /** 跳过该路径的自绘（锚点编辑时由 UI 叠加层绘制预览）。 */
  hidePathId?: NodeId;
  /** 拖动中的渲染期预览：命中的"移动根"整体偏移，不改文档。 */
  movePreview?: { ids: readonly NodeId[]; dx: number; dy: number };
  /** 缩放中的渲染期预览：命中的节点用给定几何绘制。 */
  resizePreview?: { id: NodeId; x: number; y: number; width: number; height: number };
  /** 路径缩放预览：锚点按同一比例缩放后的几何（不改文档）。 */
  vectorPreview?: { id: NodeId; vector: VectorPath };
  /** 拖入自动布局容器的让位预览：命中的节点用给定几何绘制（不改文档）。 */
  geometryPreview?: ReadonlyMap<NodeId, { x: number; y: number; width: number; height: number }>;
  /** 需要淡化的页面（编辑模式下的非活动页）。 */
  dimPageIds?: readonly NodeId[];
  /**
   * 图片解码缓存入口（渲染层注入；缺省视为全部缺失）
   */
  resolveImage?: (assetId: string) => ResolvedImage | null;
  /**
   * 链接（远程）图片的解码缓存入口（渲染层注入；缺省视为全部未加载）。
   * 与 `resolveImage` 分开：嵌入图按内容哈希取，链接图按 URL 取。
   */
  resolveLinkedImage?: (url: string) => ResolvedImage | null;
  /**
   * 只画这些子树（导出选区用）：不画页面底，按各自的世界位置摆放。
   * 与 `dimPageIds` 互斥——导出时不需要页面淡化。
   */
  onlyRootIds?: readonly NodeId[];
  /**
   * 只画这些页面，并跳过所有根级主组件（页面导出用）。
   * 与 `onlyRootIds` 互斥：选区导出走 `onlyRootIds`。
   */
  onlyPageIds?: readonly NodeId[];
}

/**
 * 根节点的绘制清单：页面与主组件分开排。
 *
 * `onlyPageIds` 有值时只取这些页面、且不画母版——页面导出不该把画在页面上的母版
 * 一起带进 PNG（ADR-0025）。
 */
export function rootDrawPlan(
  doc: DocState,
  onlyPageIds?: readonly NodeId[],
): { pages: DocNode[]; components: DocNode[] } {
  const pages: DocNode[] = [];
  const components: DocNode[] = [];
  for (const id of doc.rootIds) {
    const node = doc.nodes[id];
    if (!node) continue;
    if (node.type === "page") {
      if (!onlyPageIds || onlyPageIds.includes(id)) pages.push(node);
    } else if (node.type === "component" && !onlyPageIds) {
      components.push(node);
    }
  }
  return { pages, components };
}

/** 绘制所有页面与内容（不含帧生命周期，便于宿主插入背景网格）。 */
export function drawDocument(backend: RenderBackend, doc: DocState, options: DrawOptions = {}): void {
  const ctx: RenderContext = {
    doc,
    resolveColor: (p) => resolvePaint(doc, p),
    resolveImage: options.resolveImage ?? (() => null),
    resolveLinkedImage: options.resolveLinkedImage ?? (() => null),
  };
  // 导出选区：只画选中的子树，按世界位置摆放，不画页面底
  if (options.onlyRootIds) {
    for (const id of options.onlyRootIds) {
      const node = doc.nodes[id];
      if (!node) continue;
      // 祖先链的平移与旋转都要压进去：只压平移的话，旋转分组里的子节点会落错位置
      const chain: DocNode[] = [];
      let cur = node.parentId ? doc.nodes[node.parentId] : undefined;
      while (cur) {
        chain.push(cur);
        cur = cur.parentId ? doc.nodes[cur.parentId] : undefined;
      }
      for (const ancestor of chain.reverse()) {
        backend.pushTransform(ancestor.x, ancestor.y, ancestor.rotation, ancestor.width, ancestor.height);
      }
      drawNode(backend, ctx, node, options);
      for (const _ancestor of chain) backend.popTransform();
    }
    return;
  }

  const plan = rootDrawPlan(doc, options.onlyPageIds);
  for (const page of plan.pages) {
    const pageId = page.id;
    const dimmed = Boolean(options.dimPageIds?.includes(pageId));
    // 页面淡化的包围盒交给后端退化为视口：整页子树遍历太贵，而层本身会被视口裁住
    if (dimmed) backend.pushOpacity(0.35);
    const geo = geometryOf(page, options);
    // 页面 = 画布上的画板（带柔和投影）：背景取页面的填充，缺省白
    backend.drawRect(
      geo.x !== page.x || geo.y !== page.y || geo.width !== page.width || geo.height !== page.height
        ? { ...page, ...geo }
        : page,
      resolvePaint(doc, page.style.fill) ?? "#ffffff",
      "rgba(15,23,42,0.10)",
      1,
      { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
      true,
    );
    // 页面背景图：盖在背景色之上、子节点之下
    const background = page.backgroundImage;
    if (background) {
      const resolved = options.resolveImage?.(background.assetId) ?? null;
      if (resolved) {
        backend.drawImageInRect(
          resolved,
          { x: geo.x, y: geo.y, width: geo.width, height: geo.height },
          background.fit,
        );
      }
    }
    backend.pushTransform(geo.x, geo.y);
    drawChildren(backend, ctx, page.children, options);
    backend.popTransform();
    if (dimmed) backend.popOpacity();
  }

  // 主组件是文档根节点，不属于任何页面：页面全部画完之后再画，永远浮在页面之上
  // （ADR-0025）。母版只是普通容器，没有页面底色与投影。
  for (const node of plan.components) drawNode(backend, ctx, node, options);
}

export function renderDocument(backend: RenderBackend, doc: DocState, vp: Viewport): void {
  backend.beginFrame(vp);
  drawDocument(backend, doc);
  backend.endFrame();
}

export type { NodeId };
