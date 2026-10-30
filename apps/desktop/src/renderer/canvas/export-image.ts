/**
 * 按倍率导出 PNG：给「复制为图片」与「导出 PNG…」共用。
 *
 * 与 MCP 的 `screenshot` 不同，这里不吃当前缩放——画布缩放到 5% 时导出的图
 * 依然是 2× 的清晰图。选区导出透明背景，页面导出带页面背景。
 */
import { subtreeWorldBounds, worldRect, type DocState, type NodeId, type Rect } from "@sqraft/core";
import { Canvas2DBackend, drawDocument, type ResolvedImage, type Viewport } from "@sqraft/render";
import { imageAssetIds } from "./image-assets";

export interface ExportRequest {
  /** 要导出的页面（选区导出时仍用它取坐标基准） */
  pageId: NodeId;
  /** 有值时导出这些子树（透明背景），否则导出整页 */
  nodeIds?: readonly NodeId[];
  /** 倍率：1 / 2 / 3 */
  scale: number;
  resolveImage: (assetId: string) => ResolvedImage | null;
  /** 异步解码入口（可选）：导出前把用到的图片先解码，避免落成占位 */
  ensureImage?: (assetId: string) => Promise<ResolvedImage | null>;
}

/**
 * 导出区域（世界坐标）。
 *
 * 选区用 `subtreeWorldBounds`：含旋转后的四边形、效果外扩与子树越界，避免导出的
 * 图被裁角/裁阴影；页面导出仍取页面矩形（页面外的内容按设计裁掉）。
 */
export function exportBounds(doc: DocState, request: Pick<ExportRequest, "pageId" | "nodeIds">): Rect | null {
  const boxes = request.nodeIds?.length
    ? request.nodeIds
        .map((id) => subtreeWorldBounds(doc, id))
        .filter((box): box is Rect => Boolean(box))
    : [worldRect(doc, request.pageId)].filter((box): box is Rect => Boolean(box));
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/**
 * 先解码再用同步渲染：刚打开文档/刚粘贴时图片可能只在缓存外，
 * 直接 `renderPng` 会画成占位图。
 */
export async function renderPngAsync(doc: DocState, request: ExportRequest): Promise<string> {
  if (request.ensureImage) {
    const ensure = request.ensureImage;
    const ids = imageAssetIds(doc, { pageId: request.pageId, nodeIds: request.nodeIds });
    await Promise.all(ids.map((id) => ensure(id).catch(() => null)));
  }
  return renderPng(doc, request);
}

/** 渲染成 PNG data URL；失败返回空串。 */
export function renderPng(doc: DocState, request: ExportRequest): string {
  const rect = exportBounds(doc, request);
  if (!rect) return "";
  const scale = Math.min(4, Math.max(0.25, request.scale || 1));
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  // 超大导出直接拒绝，避免一次分配几百 MB
  if (width * height > 80_000_000) return "";

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const backend = new Canvas2DBackend(ctx);
  const viewport: Viewport = { x: rect.x, y: rect.y, width, height, zoom: scale, dpr: 1 };
  backend.beginFrame(viewport);
  drawDocument(backend, doc, {
    resolveImage: request.resolveImage,
    // 选区导出：只画子树（透明底）；页面导出：正常画，视口会裁掉页面外的内容
    onlyRootIds: request.nodeIds?.length ? request.nodeIds : undefined,
  });
  backend.endFrame();
  return canvas.toDataURL("image/png");
}
