/**
 * SVG 导出：把 `drawDocument` 跑在 `SvgBackend` 上，补上宿主才能提供的东西
 * （文本度量、图片字节、字体字节、背景模糊的栅格化兜底）。
 *
 * 取景与 PNG 共用 `exportBounds`：有选区导选区（透明底），没选区导当前页。
 */
import {
  SvgBackend,
  drawDocument,
  type ResolvedImage,
  type SvgFontFace,
  type Viewport,
} from "@sqraft/render";
import { subtreeWorldBounds, type DocNode, type DocState, type NodeId, type Rect } from "@sqraft/core";
import { assetBytes } from "../assets";
import { fontsForSave } from "../fonts";
import { linkedImage } from "../linked-images";
import { measureText } from "../text-metrics";
import { exportBounds, preloadImages, renderPngAsync, type ExportRequest } from "./export-image";

export interface SvgExportResult {
  svg: string;
  /** 被栅格化的节点名（背景模糊这种 SVG 表达不了的效果） */
  rasterized: string[];
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 把解码后的位图重新编码成 data URL（链接图没有原始字节时用）。 */
function hrefOfImage(image: ResolvedImage): string | null {
  const source = image.source;
  if (!(source instanceof HTMLCanvasElement) && !(source instanceof HTMLImageElement) && !(source instanceof ImageBitmap)) {
    return null;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width));
    canvas.height = Math.max(1, Math.round(image.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** 导出范围里所有带可见 backdrop-blur 的节点（按世界包围盒栅格化）。 */
function backdropBlurNodes(doc: DocState, request: Pick<ExportRequest, "pageId" | "nodeIds">): DocNode[] {
  const out: DocNode[] = [];
  const visit = (id: NodeId): void => {
    const node = doc.nodes[id];
    if (!node || !node.visible) return;
    if (node.style.effects?.some((e) => e.visible && e.type === "backdrop-blur")) out.push(node);
    for (const child of node.children) visit(child);
  };
  if (request.nodeIds?.length) {
    for (const id of request.nodeIds) visit(id);
  } else if (request.pageId) {
    visit(request.pageId);
  }
  return out;
}

/**
 * 渲染成 SVG 源码。返回空串表示没有可导出的内容（与 `renderPng` 的约定一致）。
 */
export async function renderSvgAsync(doc: DocState, request: ExportRequest): Promise<SvgExportResult> {
  await preloadImages(doc, request);
  const rect = exportBounds(doc, request);
  if (!rect) return { svg: "", rasterized: [] };

  // 背景模糊：SVG 没有背景快照，只能整棵子树栅格化后贴回去
  const rasterFallback = new Map<NodeId, { href: string; rect: Rect }>();
  const rasterized: string[] = [];
  for (const node of backdropBlurNodes(doc, request)) {
    const box = subtreeWorldBounds(doc, node.id);
    if (!box) continue;
    const href = await renderPngAsync(doc, {
      pageId: request.pageId,
      nodeIds: [node.id],
      scale: 2,
      resolveImage: request.resolveImage,
      resolveLinkedImage: request.resolveLinkedImage,
      ensureImage: request.ensureImage,
      ensureLinkedImage: request.ensureLinkedImage,
    });
    if (!href) continue;
    rasterFallback.set(node.id, { href, rect: box });
    rasterized.push(node.name);
  }

  const fonts: SvgFontFace[] = fontsForSave(doc).map((font) => ({
    family: font.family,
    weight: font.weight,
    style: font.style,
    mime: font.mime,
    bytes: font.bytes,
  }));

  const backend = new SvgBackend({ viewport: viewportOf(rect), measure: measureText, fonts });
  const resolveImage = (assetId: string): ResolvedImage | null => {
    const image = request.resolveImage(assetId);
    if (!image || image.href) return image;
    const asset = assetBytes(assetId);
    if (!asset) return image;
    return { ...image, href: `data:${asset.mime};base64,${base64Of(asset.bytes)}` };
  };
  const resolveLinkedImage = (url: string): ResolvedImage | null => {
    const image = request.resolveLinkedImage?.(url) ?? linkedImage(url);
    if (!image || image.href) return image;
    const href = hrefOfImage(image);
    return href ? { ...image, href } : image;
  };

  backend.beginFrame(viewportOf(rect));
  drawDocument(backend, doc, {
    resolveImage,
    resolveLinkedImage,
    rasterFallback: rasterFallback.size ? rasterFallback : undefined,
    onlyRootIds: request.nodeIds?.length ? request.nodeIds : undefined,
    onlyPageIds: request.nodeIds?.length ? undefined : request.pageId ? [request.pageId] : undefined,
  });
  backend.endFrame();

  return { svg: backend.toSvg(), rasterized };
}

function viewportOf(rect: Rect): Viewport {
  return { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height), zoom: 1, dpr: 1 };
}
