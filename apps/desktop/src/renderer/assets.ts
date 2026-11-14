/**
 * 图片资源仓库：位图字节按内容哈希存在内存里，保存时写进 `.sqraft` 的 `assets/`。
 *
 * 三条约束：
 * - 文档只认 `assetId`，渲染层通过 `imageFor()` 拿已解码的位图；
 * - 解码走 LRU（按**解码后**的字节数，不是压缩后的大小），切页/关文档不会把内存吃满；
 * - 缺资源时返回 null，由渲染层画占位——绝不把 null 当"没有图片"静默跳过。
 */
import type { ResolvedImage } from "@sqraft/render";
import { hooks } from "./store";
import { t } from "./i18n";
import { imageDimensions, type ImageDimensions } from "./image-size";

export interface AssetRecord {
  id: string;
  mime: string;
  bytes: Uint8Array;
  /**
   * 供检查器缩略图 / SVG 解码用的 object URL，**用到时才建**（`urlOf`）。
   * 打开大稿时为几百张图各建一个 Blob 等于把全部图片字节再复制一遍，而大部分图根本不会被看到。
   */
  url: string | null;
}

function urlOf(record: AssetRecord): string {
  record.url ??= URL.createObjectURL(new Blob([blobPart(record.bytes)], { type: record.mime }));
  return record.url;
}

/** 资源字节都来自普通 ArrayBuffer（文件读取 / 零拷贝视图），不会是 SharedArrayBuffer；这里只收窄类型，不复制。 */
function blobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

function revokeUrl(record: AssetRecord): void {
  if (record.url) URL.revokeObjectURL(record.url);
  record.url = null;
}

/** 单文件上限：超过就给可读错误，不静默丢弃。 */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_ASSET_SIDE = 8192;
/** 解码缓存上限（按解码后的 RGBA 字节算） */
const DECODE_BUDGET = 256 * 1024 * 1024;

const records = new Map<string, AssetRecord>();
const decoded = new Map<string, ResolvedImage>();
/** 每张已解码位图占的内存：宽 × 高 × 4（RGBA）。压缩率再高也不能少占这么多 */
const decodedSizes = new Map<string, number>();
/** 解码失败过的资源：别每帧重试 */
const failed = new Set<string>();
/** 同一资源只允许一个解码在飞（拖动时每帧都会来问） */
const inflight = new Map<string, Promise<ResolvedImage>>();

/** 解码后占用的内存字节数（导出仅为可测）。 */
export function decodedSizeOf(image: Pick<ResolvedImage, "width" | "height">): number {
  return Math.max(1, Math.round(image.width) * Math.round(image.height) * 4);
}

/** 按 magic bytes 判真实格式：扩展名和 MIME 都不可信。 */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((b, i) => bytes[i] === b)) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    const head = String.fromCharCode(...bytes.slice(0, 6));
    if (head.startsWith("GIF8")) return "image/gif";
    if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
      return "image/webp";
    }
  }
  // SVG 是文本，只能看开头；限制在前面一小段，避免把大文件读成字符串
  const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

/** Uint8Array → 独立 ArrayBuffer（Blob/digest 的类型要求，顺带避免共享缓冲）。 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** 内容哈希 → 16 字符 id（足够避免同一文档内碰撞，且文件名短）。 */
export function assetIdFor(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", toBuffer(bytes)).then((digest) => {
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 16);
  });
}

function extensionOf(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

export function assetEntryName(asset: AssetRecord): string {
  return `assets/${asset.id}.${extensionOf(asset.mime)}`;
}

/** 位图释放：ImageBitmap 有 close()，SVG 的 <img> 没有。 */
export function releaseImage(image: ResolvedImage | undefined): void {
  const source = image?.source as ImageBitmap | undefined;
  if (source && typeof source.close === "function") source.close();
}

function totalDecodedBytes(): number {
  let total = 0;
  for (const size of decodedSizes.values()) total += size;
  return total;
}

/**
 * 分级解码（mip 级别）：级别 k 的位图是原图的 1/2^k。画布按"这张图在屏幕上实际需要多少像素"
 * 挑级别，导出 / 新插入图片走 0 级（原图）。缓存键是 `id#k`，同一张图的多个级别各自记账。
 *
 * 动机：大稿里一张 6000×4004 的照片解码后占 96 MB，256 MB 的预算只装得下两三张，
 * 滚动时会反复淘汰 → 重新解码 → 重新上传 GPU，GPU 被打满；而它在屏幕上往往只有几百像素宽。
 */
const MAX_LEVEL = 6;
/** 降采样后长边不低于这个像素数：太小的图没必要再分级 */
const MIN_LEVEL_SIDE = 256;

function cacheKey(id: string, level: number): string {
  return `${id}#${level}`;
}

/** 原图尺寸（按显示方向）：读文件头，不解码；认不出就是 null（只能整图解码）。 */
const dimensionCache = new Map<string, ImageDimensions | null>();
function dimensionsOf(record: AssetRecord): ImageDimensions | null {
  if (!dimensionCache.has(record.id)) {
    dimensionCache.set(record.id, record.mime === "image/svg+xml" ? null : imageDimensions(record.bytes, record.mime));
  }
  return dimensionCache.get(record.id) ?? null;
}

/** 屏幕上需要 `want`×原图分辨率时该用的级别：取不低于需求的最粗一级。 */
function levelFor(record: AssetRecord, want: number | undefined): number {
  if (want === undefined || !(want > 0) || want >= 1) return 0;
  const size = dimensionsOf(record);
  if (!size) return 0;
  let level = Math.floor(Math.log2(1 / want));
  level = Math.min(level, MAX_LEVEL);
  while (level > 0 && Math.max(size.width, size.height) / 2 ** level < MIN_LEVEL_SIDE) level -= 1;
  return Math.max(0, level);
}

/** 淘汰最久未用的解码结果，直到回到预算内；`keepKey` 是刚解码完的那张，永远不淘汰它。 */
function evictIfNeeded(keepKey?: string): void {
  let total = totalDecodedBytes();
  for (const key of decoded.keys()) {
    if (total <= DECODE_BUDGET) break;
    if (key === keepKey) continue;
    releaseImage(decoded.get(key));
    decoded.delete(key);
    total -= decodedSizes.get(key) ?? 0;
    decodedSizes.delete(key);
  }
}

/** 位图真实占用：按**实际解码出来的**像素算（分级后远小于原图尺寸）。 */
function bitmapBytes(image: ResolvedImage): number {
  const source = image.source as { width?: number; height?: number };
  const k = image.scale ?? 1;
  return decodedSizeOf({ width: source.width ?? image.width * k, height: source.height ?? image.height * k });
}

function remember(record: AssetRecord, level: number, image: ResolvedImage): void {
  // 解码期间文档可能已经换了（resetAssets 清空仓库）：不要往空仓库里塞旧图
  if (!records.has(record.id)) return;
  const key = cacheKey(record.id, level);
  decoded.set(key, image);
  decodedSizes.set(key, bitmapBytes(image));
  evictIfNeeded(key);
}

/** 命中时挪到 Map 末尾：淘汰按"最近使用"而不是"解码先后"，屏幕上正画着的图不会被挤掉。 */
function touch(key: string): ResolvedImage | undefined {
  const hit = decoded.get(key);
  if (hit) {
    decoded.delete(key);
    decoded.set(key, hit);
  }
  return hit;
}

function forgetDecoded(id: string): void {
  for (const key of [...decoded.keys()]) {
    if (!key.startsWith(`${id}#`)) continue;
    releaseImage(decoded.get(key));
    decoded.delete(key);
    decodedSizes.delete(key);
  }
}

/** 丢掉一条资源记录（解码失败/超限时不留半成品，免得它跟着保存进 zip）。 */
function dropRecord(record: AssetRecord): void {
  records.delete(record.id);
  revokeUrl(record);
  forgetDecoded(record.id);
  failed.add(record.id);
}

async function decode(record: AssetRecord, level: number): Promise<ResolvedImage> {
  const size = level > 0 ? dimensionsOf(record) : null;
  if (size) {
    const k = 2 ** -level;
    const bitmap = await createImageBitmap(new Blob([blobPart(record.bytes)], { type: record.mime }), {
      imageOrientation: "from-image",
      resizeWidth: Math.max(1, Math.round(size.width * k)),
      resizeHeight: Math.max(1, Math.round(size.height * k)),
      resizeQuality: "medium",
    });
    return { source: bitmap, width: size.width, height: size.height, scale: bitmap.width / size.width };
  }
  // SVG 才需要 URL（经 <img> 解码）；位图直接从字节解
  return decodeImageBytes(record.bytes, record.mime, record.mime === "image/svg+xml" ? urlOf(record) : "");
}

/**
 * 字节 → 可直接绘制的图。`url` 是这些字节的 object URL（SVG 必须经 `<img>` 解码，
 * 因为 createImageBitmap 对 SVG 支持不稳）。
 */
export async function decodeImageBytes(bytes: Uint8Array, mime: string, url: string): Promise<ResolvedImage> {
  if (mime === "image/svg+xml") {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth || 1, height: image.naturalHeight || 1 };
  }
  const bitmap = await createImageBitmap(new Blob([toBuffer(bytes)], { type: mime }), {
    imageOrientation: "from-image",
  });
  return { source: bitmap, width: bitmap.width, height: bitmap.height };
}

/** 同一资源同一级别只解一次：没解码时每帧都会调到这里，重复发起会把内存打爆。 */
function ensureDecoded(record: AssetRecord, level = 0): Promise<ResolvedImage> {
  const key = cacheKey(record.id, level);
  const running = inflight.get(key);
  if (running) return running;
  const task = decode(record, level).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/** 注册一份字节（已在仓库里就直接复用），返回 id 与原图尺寸。 */
export async function putAsset(
  bytes: Uint8Array,
): Promise<{ ok: true; id: string; mime: string; width: number; height: number } | { ok: false; reason: string }> {
  if (bytes.length === 0) return { ok: false, reason: t("error.emptyFile") };
  if (bytes.length > MAX_ASSET_BYTES) {
    return { ok: false, reason: t("error.imageTooLarge", { mb: Math.round(MAX_ASSET_BYTES / 1024 / 1024) }) };
  }
  const mime = sniffMime(bytes);
  if (!mime) return { ok: false, reason: t("error.unsupportedImage") };

  const id = await assetIdFor(bytes);
  let record = records.get(id);
  const created = !record;
  if (!record) {
    record = { id, mime, bytes, url: null };
    records.set(id, record);
  }
  const owned = record;

  let image = decoded.get(cacheKey(id, 0));
  if (!image) {
    try {
      image = await ensureDecoded(owned);
    } catch {
      if (created) dropRecord(owned);
      return { ok: false, reason: t("error.imageDecode") };
    }
    if (Math.max(image.width, image.height) > MAX_ASSET_SIDE) {
      if (created) dropRecord(owned);
      return { ok: false, reason: t("error.imageSideTooLarge", { px: MAX_ASSET_SIDE }) };
    }
    failed.delete(id);
    remember(owned, 0, image);
  }
  return { ok: true, id, mime, width: image.width, height: image.height };
}

/**
 * 渲染入口：只返回已解码的位图，未就绪时触发解码并返回 null（解码完会请求重绘）。
 *
 * `want` = 屏幕上需要的分辨率占原图的比例（0–1，缺省 = 要原图）。有更精细的级别已经在缓存里就直接用；
 * 只有更粗的级别时先拿它顶上（不闪占位），同时在后台解码需要的级别。
 */
export function imageFor(assetId: string, want?: number): ResolvedImage | null {
  if (failed.has(assetId)) return null;
  const record = records.get(assetId);
  if (!record) return null;
  const level = levelFor(record, want);
  const exact = touch(cacheKey(assetId, level));
  if (exact) return exact;

  // 已有更精细的级别：直接用（画质只会更好），**不再**后台解更粗的一级——
  // 缩小时每张图都去补解一次，解完的重绘请求会让整页缓存反复失效（ADR-0033）。内存由 LRU 兜底
  for (let l = level - 1; l >= 0; l--) {
    const finer = touch(cacheKey(assetId, l));
    if (finer) return finer;
  }
  // 只有更粗的：先顶上（不闪占位），同时后台解需要的级别
  let fallback: ResolvedImage | null = null;
  for (let l = level + 1; l <= MAX_LEVEL && !fallback; l++) fallback = touch(cacheKey(assetId, l)) ?? null;

  void ensureDecoded(record, level)
    .then((image) => {
      if (Math.max(image.width, image.height) > MAX_ASSET_SIDE) {
        // 只标记失败，**不删字节**：这张图来自用户文件，删了再保存就把图弄丢了
        failed.add(assetId);
        return;
      }
      remember(record, level, image);
      // 第一帧画的是占位：解码完必须自己叫一次重绘，否则要等用户平移/缩放才出图
      hooks.requestRepaint();
    })
    .catch(() => {
      failed.add(assetId);
      hooks.requestRepaint();
    });
  return fallback;
}

/**
 * 这张图是否还有解码在进行：画布据此判断"刚才画的是不是占位 / 临时的粗级别"，
 * 是的话缓存层记为未完成，图解码完再重画（不需要让整个缓存失效）。
 */
export function imagePending(assetId: string): boolean {
  for (const key of inflight.keys()) if (key.startsWith(`${assetId}#`)) return true;
  return false;
}

/**
 * 等待一份资源的**原图**解码完成（导出前预载用：`imageFor` 只读缓存，未解码会落成占位）。
 * 超限/解码失败返回 null，不抛错。
 */
export async function ensureAssetDecoded(assetId: string): Promise<ResolvedImage | null> {
  const hit = touch(cacheKey(assetId, 0));
  if (hit) return hit;
  if (failed.has(assetId)) return null;
  const record = records.get(assetId);
  if (!record) return null;
  try {
    const image = await ensureDecoded(record);
    if (Math.max(image.width, image.height) > MAX_ASSET_SIDE) {
      failed.add(assetId);
      return null;
    }
    remember(record, 0, image);
    return image;
  } catch {
    failed.add(assetId);
    return null;
  }
}

/** 图层面板缩略图用；资源不存在时返回 null。 */
export function assetUrl(assetId: string): string | null {
  const record = records.get(assetId);
  return record ? urlOf(record) : null;
}

export function hasAsset(assetId: string): boolean {
  return records.has(assetId);
}

export function allAssets(): AssetRecord[] {
  return [...records.values()];
}

/** 打开文件时把 zip 里的 assets/ 注册进来（不做解码，用到再说）。 */
export function loadAssets(files: Record<string, Uint8Array>): void {
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith("assets/")) continue;
    const id = path.slice("assets/".length).replace(/\.[^.]+$/, "");
    if (records.has(id)) continue;
    const mime = sniffMime(bytes);
    if (!mime) continue;
    failed.delete(id);
    records.set(id, { id, mime, bytes, url: null });
  }
}

/** 新建/关闭文档时清空（object URL 与解码位图都必须显式释放）。 */
export function resetAssets(): void {
  for (const record of records.values()) revokeUrl(record);
  for (const image of decoded.values()) releaseImage(image);
  records.clear();
  decoded.clear();
  decodedSizes.clear();
  inflight.clear();
  failed.clear();
  dimensionCache.clear();
}
