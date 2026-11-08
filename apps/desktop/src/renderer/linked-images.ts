/**
 * 链接（远程）图片的解码缓存（ADR-0027）。
 *
 * 文档只存 URL；字节由主进程抓取并缓存在 `userData/image-cache/`
 * （见 `main/image-cache.ts`），这里只管"按 URL 去重 → 解码 → LRU → 通知重绘"。
 *
 * 渲染热路径必须同步：`linkedImage()` 未就绪时返回 null（画占位），
 * 并在后台发起一次抓取；解码完成后自己叫一次重绘。
 */
import { ref } from "vue";
import type { ResolvedImage } from "@sqraft/render";
import { hooks } from "./store";
import { decodeImageBytes, decodedSizeOf, MAX_ASSET_SIDE, releaseImage, sniffMime } from "./assets";
import { t } from "./i18n";

/** 解码缓存上限（按解码后的 RGBA 字节算） */
const DECODE_BUDGET = 128 * 1024 * 1024;

/**
 * 缓存状态的响应式版本号：面板（检查器/图层缩略图）读它来重新渲染。
 * 画布不走 Vue 响应式，解码完成由 `hooks.requestRedraw()` 触发重绘。
 */
export const linkedVersion = ref(0);

function bump(): void {
  linkedVersion.value += 1;
  hooks.requestRedraw();
}

interface Entry {
  status: "loading" | "ready" | "failed";
  image?: ResolvedImage;
  /** 字节的 object URL：SVG 解码与检查器预览都用它 */
  objectUrl?: string;
  /** 解码后占用的字节数（LRU 依据） */
  size?: number;
  lastUsed?: number;
  error?: string;
}

const entries = new Map<string, Entry>();
/** 同一 URL 只允许一个抓取+解码在飞 */
const inflight = new Map<string, Promise<ResolvedImage | null>>();
/** 每次发起加载就递增：旧请求回来对不上世代就丢弃，避免覆盖「重新抓取」的新结果 */
const generations = new Map<string, number>();

function nextGeneration(url: string): number {
  const generation = (generations.get(url) ?? 0) + 1;
  generations.set(url, generation);
  return generation;
}

function isStale(url: string, generation: number): boolean {
  return generations.get(url) !== generation;
}

function release(entry: Entry): void {
  releaseImage(entry.image);
  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
}

function totalDecoded(): number {
  let total = 0;
  for (const entry of entries.values()) total += entry.size ?? 0;
  return total;
}

/** 最近用过的不会被淘汰：检查器预览正引用着它的 object URL，抽掉会闪成空白 */
const RECENT_MS = 60_000;

/** 淘汰最久未用的解码结果，直到回到预算内。 */
function evict(keep?: string): void {
  let total = totalDecoded();
  if (total <= DECODE_BUDGET) return;
  const now = Date.now();
  const candidates = [...entries.entries()]
    .filter(([url, entry]) => url !== keep && entry.status === "ready" && now - (entry.lastUsed ?? 0) > RECENT_MS)
    .sort((a, b) => (a[1].lastUsed ?? 0) - (b[1].lastUsed ?? 0));
  for (const [url, entry] of candidates) {
    if (total <= DECODE_BUDGET) break;
    release(entry);
    entries.delete(url);
    total -= entry.size ?? 0;
  }
}

function markFailed(url: string, reason: string): null {
  entries.set(url, { status: "failed", error: reason });
  bump();
  return null;
}

/** 抓取 + 解码；失败记录原因，不抛错（画布画占位，导出也不阻断）。 */
async function load(url: string, force = false): Promise<ResolvedImage | null> {
  const running = force ? undefined : inflight.get(url);
  if (running) return running;
  const generation = nextGeneration(url);
  const stale = (): boolean => isStale(url, generation);
  const task = (async (): Promise<ResolvedImage | null> => {
    let result: Awaited<ReturnType<typeof window.sqraft.app.fetchImage>>;
    try {
      result = await window.sqraft.app.fetchImage(url, force ? { force: true } : undefined);
    } catch (error) {
      // 桥断了（preload 未就绪/主进程异常）：别让一个 rejected promise 让状态永远停在 loading
      if (stale()) return null;
      return markFailed(url, t("error.fetchImage", { detail: error instanceof Error ? error.message : String(error) }));
    }
    if (stale()) return null;
    if (!result.ok) return markFailed(url, result.reason);
    const mime = sniffMime(result.bytes);
    if (!mime) return markFailed(url, t("error.unrecognizedImage"));
    // IPC 回来的 Uint8Array 底层可能是 SharedArrayBuffer：Blob 需要一个独立的 ArrayBuffer
    const buffer = new ArrayBuffer(result.bytes.byteLength);
    new Uint8Array(buffer).set(result.bytes);
    const objectUrl = URL.createObjectURL(new Blob([buffer], { type: mime }));
    try {
      const image = await decodeImageBytes(result.bytes, mime, objectUrl);
      // 解码期间用户点了「重新抓取」：这张已经过期，别覆盖新结果
      if (stale()) {
        releaseImage(image);
        URL.revokeObjectURL(objectUrl);
        return null;
      }
      if (Math.max(image.width, image.height) > MAX_ASSET_SIDE) {
        URL.revokeObjectURL(objectUrl);
        return markFailed(url, t("error.imageSideTooLarge", { px: MAX_ASSET_SIDE }));
      }
      entries.set(url, {
        status: "ready",
        image,
        objectUrl,
        size: decodedSizeOf(image),
        lastUsed: Date.now(),
      });
      evict(url);
      bump();
      return image;
    } catch {
      URL.revokeObjectURL(objectUrl);
      if (stale()) return null;
      return markFailed(url, t("error.imageDecode"));
    }
  })().finally(() => inflight.delete(url));
  inflight.set(url, task);
  return task;
}

/** 关文档/换文档时释放解码结果与 object URL（磁盘缓存不动，下次打开还能直接用）。 */
export function resetLinkedImages(): void {
  for (const entry of entries.values()) release(entry);
  entries.clear();
  inflight.clear();
  generations.clear();
  bump();
}

/** 渲染入口：只返回已解码的图，未就绪时触发抓取并返回 null。 */
export function linkedImage(url: string): ResolvedImage | null {
  const entry = entries.get(url);
  if (entry?.status === "ready" && entry.image) {
    entry.lastUsed = Date.now();
    return entry.image;
  }
  if (!entry) {
    entries.set(url, { status: "loading" });
    void load(url);
  }
  return null;
}

/**
 * 等待一张图就绪（导出/截图前预载）。失败会重试一次：
 * 上一次可能只是断网，导出时网络已经回来了。
 */
export async function ensureLinkedImage(url: string): Promise<ResolvedImage | null> {
  const entry = entries.get(url);
  if (entry?.status === "ready" && entry.image) return entry.image;
  if (entry?.status === "failed") entries.delete(url);
  return load(url);
}

/** 用户点「重新抓取」：丢掉当前结果重新走一次（主进程仍会先看缓存）。 */
export function refreshLinkedImage(url: string): void {
  const entry = entries.get(url);
  if (entry) release(entry);
  entries.set(url, { status: "loading" });
  bump();
  void load(url, true);
}

/** 检查器预览用的 object URL（未加载时为 null）；读取时刷新"最近使用"，避免被即时淘汰。 */
export function linkedPreviewUrl(url: string | undefined): string | null {
  if (!url) return null;
  const entry = entries.get(url);
  if (!entry?.objectUrl) return null;
  entry.lastUsed = Date.now();
  return entry.objectUrl;
}

/** 状态与失败原因（纯读取，不触发抓取）；加载由 `ensureLinkedImage` / 画布负责。 */
export function linkedImageStatus(url: string): { status: Entry["status"] | "idle"; error?: string } {
  const entry = entries.get(url);
  if (!entry) return { status: "idle" };
  return { status: entry.status, error: entry.error };
}

/** 已经解码出来的原图尺寸（检查器显示"原图 W × H"用）；未知返回 null。 */
export function linkedNaturalSize(url: string | undefined): { width: number; height: number } | null {
  if (!url) return null;
  const image = entries.get(url)?.image;
  return image ? { width: image.width, height: image.height } : null;
}
