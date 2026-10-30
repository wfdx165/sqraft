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

export interface AssetRecord {
  id: string;
  mime: string;
  bytes: Uint8Array;
  /** 供图层面板缩略图用的 object URL（与 bytes 同生命周期） */
  url: string;
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
function releaseImage(image: ResolvedImage | undefined): void {
  const source = image?.source as ImageBitmap | undefined;
  if (source && typeof source.close === "function") source.close();
}

function totalDecodedBytes(): number {
  let total = 0;
  for (const size of decodedSizes.values()) total += size;
  return total;
}

/** 淘汰最久未用的解码结果，直到回到预算内；`keepId` 是刚解码完的那张，永远不淘汰它。 */
function evictIfNeeded(keepId?: string): void {
  let total = totalDecodedBytes();
  for (const id of decoded.keys()) {
    if (total <= DECODE_BUDGET) break;
    if (id === keepId) continue;
    releaseImage(decoded.get(id));
    decoded.delete(id);
    total -= decodedSizes.get(id) ?? 0;
    decodedSizes.delete(id);
  }
}

function remember(record: AssetRecord, image: ResolvedImage): void {
  // 解码期间文档可能已经换了（resetAssets 清空仓库）：不要往空仓库里塞旧图
  if (!records.has(record.id)) return;
  decoded.set(record.id, image);
  decodedSizes.set(record.id, decodedSizeOf(image));
  evictIfNeeded(record.id);
}

/** 丢掉一条资源记录（解码失败/超限时不留半成品，免得它跟着保存进 zip）。 */
function dropRecord(record: AssetRecord): void {
  records.delete(record.id);
  URL.revokeObjectURL(record.url);
  decoded.delete(record.id);
  decodedSizes.delete(record.id);
  failed.add(record.id);
}

async function decode(record: AssetRecord): Promise<ResolvedImage> {
  if (record.mime === "image/svg+xml") {
    // createImageBitmap 对 SVG 支持不稳，用 <img> 解码再交给 drawImage
    const image = new Image();
    image.src = record.url;
    await image.decode();
    return { source: image, width: image.naturalWidth || 1, height: image.naturalHeight || 1 };
  }
  const bitmap = await createImageBitmap(new Blob([toBuffer(record.bytes)], { type: record.mime }), {
    imageOrientation: "from-image",
  });
  return { source: bitmap, width: bitmap.width, height: bitmap.height };
}

/** 同一资源只解一次：没解码时每帧都会调到这里，重复发起会把内存打爆。 */
function ensureDecoded(record: AssetRecord): Promise<ResolvedImage> {
  const running = inflight.get(record.id);
  if (running) return running;
  const task = decode(record).finally(() => inflight.delete(record.id));
  inflight.set(record.id, task);
  return task;
}

/** 注册一份字节（已在仓库里就直接复用），返回 id 与原图尺寸。 */
export async function putAsset(
  bytes: Uint8Array,
): Promise<{ ok: true; id: string; mime: string; width: number; height: number } | { ok: false; reason: string }> {
  if (bytes.length === 0) return { ok: false, reason: "文件是空的" };
  if (bytes.length > MAX_ASSET_BYTES) {
    return { ok: false, reason: `图片超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MB 上限` };
  }
  const mime = sniffMime(bytes);
  if (!mime) return { ok: false, reason: "不支持的图片格式（支持 PNG / JPEG / WebP / GIF / SVG）" };

  const id = await assetIdFor(bytes);
  let record = records.get(id);
  const created = !record;
  if (!record) {
    record = { id, mime, bytes, url: URL.createObjectURL(new Blob([toBuffer(bytes)], { type: mime })) };
    records.set(id, record);
  }
  const owned = record;

  let image = decoded.get(id);
  if (!image) {
    try {
      image = await ensureDecoded(owned);
    } catch {
      if (created) dropRecord(owned);
      return { ok: false, reason: "图片解码失败，文件可能已损坏" };
    }
    if (Math.max(image.width, image.height) > MAX_ASSET_SIDE) {
      if (created) dropRecord(owned);
      return { ok: false, reason: `图片边长超过 ${MAX_ASSET_SIDE}px 上限` };
    }
    failed.delete(id);
    remember(owned, image);
  }
  return { ok: true, id, mime, width: image.width, height: image.height };
}

/** 渲染入口：只返回已解码的位图，未就绪时触发解码并返回 null（解码完会请求重绘）。 */
export function imageFor(assetId: string): ResolvedImage | null {
  const hit = decoded.get(assetId);
  if (hit) return hit;
  if (failed.has(assetId)) return null;
  const record = records.get(assetId);
  if (!record) return null;
  void ensureDecoded(record)
    .then((image) => {
      if (Math.max(image.width, image.height) > MAX_ASSET_SIDE) {
        // 只标记失败，**不删字节**：这张图来自用户文件，删了再保存就把图弄丢了
        failed.add(assetId);
        return;
      }
      remember(record, image);
      // 第一帧画的是占位：解码完必须自己叫一次重绘，否则要等用户平移/缩放才出图
      hooks.requestRedraw();
    })
    .catch(() => {
      failed.add(assetId);
      hooks.requestRedraw();
    });
  return null;
}

/** 图层面板缩略图用；资源不存在时返回 null。 */
export function assetUrl(assetId: string): string | null {
  return records.get(assetId)?.url ?? null;
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
    records.set(id, { id, mime, bytes, url: URL.createObjectURL(new Blob([toBuffer(bytes)], { type: mime })) });
  }
}

/** 新建/关闭文档时清空（object URL 与解码位图都必须显式释放）。 */
export function resetAssets(): void {
  for (const record of records.values()) URL.revokeObjectURL(record.url);
  for (const image of decoded.values()) releaseImage(image);
  records.clear();
  decoded.clear();
  decodedSizes.clear();
  inflight.clear();
  failed.clear();
}
