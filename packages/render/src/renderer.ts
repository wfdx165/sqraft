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
  resolveNumericStyle,
  polygonPoints,
  subtreeWorldBounds,
} from "@sqraft/core";
import type { RenderBackend, RenderContext, RenderEffect, ResolvedImage, Viewport } from "./backend";
import { intersects } from "./cull";

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
          ? ctx.resolveImage(ref.assetId, imageWant(ctx, node))
          : ref.sourceUrl
            ? ctx.resolveLinkedImage(ref.sourceUrl)
            : null
        : null;
      // 图还没就绪（占位 / 临时粗级别）：告诉缓存层这次画的不是最终结果
      if (ref && (ref.assetId ? ctx.imagePending?.(ref.assetId) : !resolved)) backend.noteIncomplete?.();
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

/**
 * 图片在屏幕上需要的分辨率占原图的比例：节点的设备像素 ÷ 裁切区域的原图像素。
 * 宿主没给 `pixelRatio`（导出等）时返回 undefined = 要原图。
 */
function imageWant(ctx: RenderContext, node: DocNode): number | undefined {
  const ratio = ctx.pixelRatio;
  if (!ratio || !node.image) return undefined;
  const crop = imageCropOf(node);
  return Math.max((node.width * ratio) / crop.width, (node.height * ratio) / crop.height);
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
    // 蒙版层同样可以跨帧复用（ADR-0033）：蒙版或被遮的任何一方在预览 / 编辑中就不缓存
    const cache = ctx.effectCache;
    const key =
      cache && !cache.volatile.has(mask.id) && !cache.volatile.has(target.id)
        ? `${mask.id}>${target.id}@${cache.epoch}`
        : undefined;
    if (backend.pushMaskLayer(subtreeWorldBounds(ctx.doc, target.id) ?? undefined, key) === true) {
      backend.popMaskLayer(() => {}, mask.opacity ?? 1);
      continue;
    }
    drawNode(backend, ctx, target, options);
    const maskStyle = resolveNumericStyle(ctx.doc, mask.style);
    const styledMask = maskStyle === mask.style ? mask : { ...mask, style: maskStyle };
    backend.popMaskLayer(
      () => drawSelf(backend, ctx, styledMask, undefined, { mask: true }),
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
  // 屏幕上不到半个设备像素的叶子直接跳过（缩小看全局时省掉成千上万次绘制；导出不传 pixelRatio，不受影响）
  if (ctx.pixelRatio && node.children.length === 0 && tooSmallToSee(node, ctx.pixelRatio)) return;
  // 数值 Token 在读时解析：字号 / 描边宽 / 圆角等统一在这里落到字面量。
  // 没有绑定的节点返回原对象，不产生额外分配。
  const numericStyle = resolveNumericStyle(ctx.doc, node.style);
  const styled = numericStyle === node.style ? node : { ...node, style: numericStyle };
  const opacity = styled.opacity ?? 1;
  const geo = geometryOf(styled, options);
  const changed = geo.x !== styled.x || geo.y !== styled.y || geo.width !== styled.width || geo.height !== styled.height;
  const target = changed ? { ...styled, ...geo } : styled;
  // 效果层包住自绘与整棵子树：先合成，再施加效果（ADR-0018）
  const effects = resolveEffects(ctx, styled.style.effects);
  // 不透明度在外、效果在内：先按组合成，再施加效果，最后整体乘 alpha。
  // 只有一次绘制操作的叶子节点直接乘 alpha（结果相同，省一张离屏）
  const directAlpha = opacity < 1 && effects.length === 0 && singlePaint(ctx, styled);
  if (opacity < 1) {
    if (directAlpha) backend.pushAlpha(opacity);
    else backend.pushOpacity(opacity, opacityLayerBounds(ctx.doc, styled, geo, options));
  }
  // 效果层缓存命中时整棵子树不用再画（结果已经合成好了，ADR-0033）
  let cached = false;
  if (effects.length > 0) {
    const cache = ctx.effectCache;
    const key = cache && !cache.volatile.has(styled.id) ? `${styled.id}@${cache.epoch}` : undefined;
    cached = backend.pushEffects(target, effects, key) === true;
  }
  // 行内编辑中的文本由 DOM 输入框承载，画布上跳过以免重影
  if (!cached && styled.id !== options.hideTextId && styled.id !== options.hidePathId) {
    const vectorOverride =
      options.vectorPreview && options.vectorPreview.id === styled.id ? options.vectorPreview.vector : undefined;
    drawSelf(backend, ctx, target, vectorOverride);
  }
  if (!cached && styled.children.length > 0) {
    backend.pushTransform(geo.x, geo.y, styled.rotation, geo.width, geo.height);
    const clipped = styled.clip && (styled.type === "frame" || styled.type === "component" || styled.type === "instance");
    if (clipped) backend.pushClip(0, 0, geo.width, geo.height, cornerRadiusOf(styled.style));
    drawChildren(backend, ctx, styled.children, options);
    if (clipped) backend.popClip();
    backend.popTransform();
  }
  if (effects.length > 0) backend.popEffects();
  if (opacity < 1) {
    if (directAlpha) backend.popAlpha();
    else backend.popOpacity();
  }
}

/** 叶子在屏幕上的最大尺寸（含描边）不到半个设备像素；带可见效果的不算（模糊 / 投影会扩散开）。 */
function tooSmallToSee(node: DocNode, pixelRatio: number): boolean {
  if (node.style.effects?.some((e) => e.visible)) return false;
  const extent = Math.max(Math.abs(node.width), Math.abs(node.height)) + Math.max(0, node.style.strokeWidth ?? 0);
  return extent * pixelRatio < 0.5;
}

/**
 * 节点（含子树）是否只产生一次绘制操作：没有子节点，且自绘只有填充或只有描边（图片只有一次 drawImage）。
 * 这时"先合成再乘 alpha"与"直接乘 alpha"逐像素相同；填充 + 描边两次绘制会在重叠处叠深，不能走捷径。
 */
function singlePaint(ctx: RenderContext, node: DocNode): boolean {
  if (node.children.length > 0) return false;
  if (node.type === "image") return true;
  const fill = resolvePaint(ctx.doc, node.style.fill);
  const stroke = resolvePaint(ctx.doc, node.style.stroke);
  // 下划线 / 删除线是单独一笔，与字形重叠：同样不能走捷径
  if (node.type === "text") return !stroke && (!node.style.textDecoration || node.style.textDecoration === "none");
  return !(fill && stroke);
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
   * 视口剔除（ADR-0032）：根节点（页面 / 主组件）整棵子树与 `rect` 不相交就跳过。
   *
   * - `rect`：世界坐标下的可见区域；
   * - `rootBounds`：根节点子树的保守包围盒（通常是 `createRootBoundsCache()` 的结果）；
   * - `pad`：包围盒额外外扩（世界单位），覆盖页面投影这类不进包围盒的装饰。
   *
   * 带渲染期预览（拖动 / 缩放 / 路径 / 布局让位）的根不剔除：预览几何不在缓存的包围盒里。
   * 缺省不剔除（导出等离屏渲染走这条）。淡化页面的不透明度层同时改用该页包围盒而不是整个视口。
   */
  cull?: { rect: Rect; rootBounds: (id: NodeId) => Rect | null; pad: number };
  /**
   * 效果层跨帧缓存（ADR-0033）。`epoch` 必须在任何会改变绘制结果的事件后变化：
   * 文档改动（version）、图片 / 字体等异步资源就绪。缺省不缓存（导出等离屏渲染走这条）。
   * 带预览或正在编辑的节点（及其祖先）每帧自动排除，不需要宿主处理。
   */
  effectCacheEpoch?: string;
  /**
   * 图片解码缓存入口（渲染层注入；缺省视为全部缺失）。第二个参数见 `RenderContext.resolveImage`。
   */
  resolveImage?: (assetId: string, want?: number) => ResolvedImage | null;
  /** 嵌入图是否还在解码，见 RenderContext.imagePending。给了才能让缓存在图片就绪前不被当成最终结果。 */
  imagePending?: (assetId: string) => boolean;
  /**
   * 设备像素 / 文档单位（画布上就是 zoom × dpr）。给了才会向宿主请求降采样的图片；
   * 导出不传，始终拿原图。
   */
  pixelRatio?: number;
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
    pixelRatio: options.pixelRatio,
    imagePending: options.imagePending,
    effectCache:
      options.effectCacheEpoch !== undefined
        ? { epoch: options.effectCacheEpoch, volatile: volatileNodes(doc, options) }
        : undefined,
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
  const dimSet = options.dimPageIds ? new Set(options.dimPageIds) : null;
  const pinned = options.cull ? previewRoots(doc, options) : null;
  /** 剔除判定：返回 false = 整棵跳过；否则返回外扩后的包围盒（预览中的根为 undefined） */
  const visibleBounds = (id: NodeId): Rect | undefined | false => {
    const cull = options.cull;
    if (!cull || pinned!.has(id)) return undefined;
    const b = cull.rootBounds(id);
    if (!b) return undefined;
    const padded = { x: b.x - cull.pad, y: b.y - cull.pad, width: b.width + cull.pad * 2, height: b.height + cull.pad * 2 };
    return intersects(padded, cull.rect) ? padded : false;
  };

  /**
   * 整页缓存（ADR-0033）：拖动画布时每个可见页面只回贴一张位图，淡化也只是回贴时乘 alpha。
   * 带预览 / 编辑中的页面、没给 epoch（导出）或没有剔除包围盒时不缓存。
   */
  const rootCache = (id: NodeId, bounds: Rect | undefined, alpha: number): "hit" | "drawing" | "uncached" => {
    const cache = ctx.effectCache;
    if (!cache || !bounds || cache.volatile.has(id) || !backend.pushRootCache) return "uncached";
    return backend.pushRootCache(bounds, `root:${id}@${cache.epoch}`, alpha);
  };

  for (const page of plan.pages) {
    const pageId = page.id;
    const bounds = visibleBounds(pageId);
    if (bounds === false) continue;
    const dimmed = Boolean(dimSet?.has(pageId));
    const mode = rootCache(pageId, bounds, dimmed ? 0.35 : 1);
    if (mode === "hit") {
      backend.popRootCache?.();
      continue;
    }
    // 淡化层（不走整页缓存时）：有剔除时取「该页包围盒 ∩ 视口」；没有时退化为视口（整页子树遍历太贵）
    if (dimmed && mode === "uncached") backend.pushOpacity(0.35, bounds);
    drawPage(backend, ctx, page, options);
    if (mode === "drawing") backend.popRootCache?.();
    else if (dimmed) backend.popOpacity();
  }

  // 主组件是文档根节点，不属于任何页面：页面全部画完之后再画，永远浮在页面之上
  // （ADR-0025）。母版只是普通容器，没有页面底色与投影。
  for (const node of plan.components) {
    const bounds = visibleBounds(node.id);
    if (bounds === false) continue;
    const mode = rootCache(node.id, bounds, 1);
    if (mode === "hit") {
      backend.popRootCache?.();
      continue;
    }
    drawNode(backend, ctx, node, options);
    if (mode === "drawing") backend.popRootCache?.();
  }
}

/** 一个页面：底色 + 投影、背景图、子树。 */
function drawPage(backend: RenderBackend, ctx: RenderContext, page: DocNode, options: DrawOptions): void {
  const doc = ctx.doc;
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
    if (ctx.imagePending?.(background.assetId)) backend.noteIncomplete?.();
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
}

/** 本帧绘制结果与文档不一致的节点（预览 / 行内编辑）及其全部祖先：它们的效果层不能用缓存。 */
function volatileNodes(doc: DocState, options: DrawOptions): Set<NodeId> {
  const ids: NodeId[] = [];
  if (options.movePreview) ids.push(...options.movePreview.ids);
  if (options.resizePreview) ids.push(options.resizePreview.id);
  if (options.vectorPreview) ids.push(options.vectorPreview.id);
  if (options.geometryPreview) ids.push(...options.geometryPreview.keys());
  if (options.hideTextId) ids.push(options.hideTextId);
  if (options.hidePathId) ids.push(options.hidePathId);
  const out = new Set<NodeId>();
  for (const id of ids) {
    let cur: DocNode | undefined = doc.nodes[id];
    while (cur && !out.has(cur.id)) {
      out.add(cur.id);
      cur = cur.parentId ? doc.nodes[cur.parentId] : undefined;
    }
  }
  return out;
}

/** 带渲染期预览的节点所在的根：这些根的真实绘制范围不等于缓存的包围盒，不能剔除。 */
function previewRoots(doc: DocState, options: DrawOptions): Set<NodeId> {
  const ids: NodeId[] = [];
  if (options.movePreview) ids.push(...options.movePreview.ids);
  if (options.resizePreview) ids.push(options.resizePreview.id);
  if (options.vectorPreview) ids.push(options.vectorPreview.id);
  if (options.geometryPreview) ids.push(...options.geometryPreview.keys());
  const roots = new Set<NodeId>();
  for (const id of ids) {
    let cur = doc.nodes[id];
    while (cur?.parentId) cur = doc.nodes[cur.parentId];
    if (cur) roots.add(cur.id);
  }
  return roots;
}

export function renderDocument(backend: RenderBackend, doc: DocState, vp: Viewport): void {
  backend.beginFrame(vp);
  drawDocument(backend, doc);
  backend.endFrame();
}

export type { NodeId };
