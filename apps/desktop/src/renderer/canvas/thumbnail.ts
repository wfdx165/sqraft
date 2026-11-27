/**
 * 欢迎页「最近打开」的封面：把一页按 16:10 等比放进 480×300 的小图。
 *
 * 与导出共用 `drawDocument`，但视口自己做：页面按 contain 居中，四周留浅灰底，
 * 这样竖屏页面（375×812）不会被裁成两截。只读已解码的图片，不触发网络抓取——
 * 封面是保存 / 打开路径上的副产物，不能因为一张链接图卡住或变慢。
 */
import { firstPageId, subtreeWorldBounds, worldRect, type DocState, type NodeId, type Rect } from "@sqraft/core";
import { Canvas2DBackend, drawDocument, type Viewport } from "@sqraft/render";
import { ensureAssetFor, imageFor } from "../assets";
import { linkedImage } from "../linked-images";
import { preloadImages } from "./export-image";

/** 封面尺寸：欢迎页展示约 212×132，2× 下够清晰，单张 JPEG 通常 20–60KB。 */
export const THUMB_WIDTH = 480;
export const THUMB_HEIGHT = 300;
/** 留白底色：比白卡深一档，让页面的边界看得出来 */
const THUMB_BACKDROP = "#eceef3";
/** 超大页面按 contain 缩放；极小页面不放大超过 4×，避免糊成马赛克 */
const MAX_SCALE = 4;
const JPEG_QUALITY = 0.85;

interface ThumbGeometry {
  rect: Rect;
  scale: number;
}

/** 页面矩形 → 放进 480×300 的缩放。页面尺寸异常时退回子树包围盒。 */
function geometryOf(doc: DocState, id: NodeId): ThumbGeometry | null {
  let rect = worldRect(doc, id);
  if (!rect || rect.width < 1 || rect.height < 1) rect = subtreeWorldBounds(doc, id);
  if (!rect || rect.width < 1 || rect.height < 1) return null;
  const scale = Math.min(THUMB_WIDTH / rect.width, THUMB_HEIGHT / rect.height, MAX_SCALE);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return { rect, scale };
}

function toBytes(canvas: HTMLCanvasElement): Uint8Array | null {
  const url = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  try {
    const binary = atob(url.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** 一次同步渲染：返回 JPEG 字节；拿不到画布或页面时返回 null（调用方跳过封面）。 */
export function renderThumbnail(doc: DocState, pageId: NodeId | null = null): Uint8Array | null {
  const id = pageId ?? firstPageId(doc);
  if (!id) return null;
  const geometry = geometryOf(doc, id);
  if (!geometry) return null;
  const { rect, scale } = geometry;

  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const backend = new Canvas2DBackend(ctx);
  const offsetX = (THUMB_WIDTH - rect.width * scale) / 2;
  const offsetY = (THUMB_HEIGHT - rect.height * scale) / 2;
  const viewport: Viewport = {
    x: rect.x - offsetX / scale,
    y: rect.y - offsetY / scale,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    zoom: scale,
    dpr: 1,
  };
  backend.beginFrame(viewport);
  // beginFrame 会 clearRect，底色必须画在它之后
  ctx.fillStyle = THUMB_BACKDROP;
  ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
  drawDocument(backend, doc, {
    resolveImage: (assetId, want) => imageFor(assetId, want ?? Math.min(1, scale)),
    resolveLinkedImage: (url) => linkedImage(url),
    onlyPageIds: [id],
  });
  backend.endFrame();

  return toBytes(canvas);
}

/**
 * 打开文件后补封面用的异步版本：先把这一页的嵌入图解到与缩略图匹配的小级别再画，
 * 否则刚 `loadAssets` 完的文档会画成占位图，缓存下来的封面就一直是灰块。
 * 链接图不预载——封面不能为了它去发网络请求。
 */
export async function renderThumbnailAsync(doc: DocState, pageId: NodeId | null = null): Promise<Uint8Array | null> {
  const id = pageId ?? firstPageId(doc);
  if (!id) return null;
  const geometry = geometryOf(doc, id);
  const want = geometry ? Math.min(1, geometry.scale) : 0.25;
  await preloadImages(doc, { pageId: id, ensureImage: (assetId) => ensureAssetFor(assetId, want) });
  return renderThumbnail(doc, id);
}
