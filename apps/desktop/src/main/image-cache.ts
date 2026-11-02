/**
 * 链接（远程）图片的抓取与本地缓存（ADR-0027）。
 *
 * 文档只存 URL，字节不进 `.sqraft`：这里负责把 URL 抓成本机缓存文件，
 * 渲染层每次要图时通过 `app.fetchImage` 拿到字节后自己解码。
 *
 * 约束：
 * - 渲染层的 CSP 是 `connect-src 'self'`，抓取只能发生在主进程；
 * - 重定向由 `net.request(redirect: "manual")` 手动跟随（最多 3 跳），每一跳都重新校验主机——
 *   `net.fetch` 的 manual 会直接取消请求，自动跟随时又拿不到最终地址（Electron 45 实测）；
 * - 每个 URL 每次应用运行只校验一次（If-None-Match / If-Modified-Since），
 *   之后直接读缓存——离线可用、也不会每帧打网络；
 * - 服务器说"变了"就换新图（静默）；抓取失败一律回退到上一次缓存，
 *   连缓存都没有才返回失败（画布画占位，导出也不阻断）；
 * - 缓存总量 500MB，按最近使用淘汰；`clearImageCache()` 给用户手动清。
 */
import { app, ipcMain, net } from "electron";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CHANNELS, type FetchImageResult } from "../shared/ipc";
import { IMAGE_CACHE_DIRNAME } from "./data-dir";
import { isHttpUrl as parseHttpUrl, isLinkLocalAddress as linkLocal } from "./image-url";
import { logApp } from "./mcp/log";
import { imageUserAgent } from "./ua";

/** 对外请求带的 UA：去掉 Electron 词（见 ua.ts），Chrome 版本跟 Electron 走 */
const IMAGE_UA = imageUserAgent(process.platform, process.versions.chrome ?? "", app.getVersion());

/** 单张图上限：与本地资源入库上限一致。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 缓存目录总量上限 */
const MAX_CACHE_BYTES = 500 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
/** 重定向最多跟几跳（每一跳都重新校验主机） */
const MAX_REDIRECTS = 3;
/** 缓存的"最近使用"时间最多隔这么久更新一次，避免每次读都写盘 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

interface CacheMeta {
  url: string;
  contentType: string;
  etag?: string;
  lastModified?: string;
  /** 最近使用时间（LRU 依据，和 bin 的 mtime 同步） */
  lastUsedAt: number;
}

/** 本进程里已经校验过的 URL：同一会话不重复发条件请求。 */
const revalidated = new Set<string>();
/** 临时文件序号：同一 URL 的并发写不能共用一个 tmp */
let tempSeq = 0;

function cacheDir(): string {
  // 跟随 Electron 的 userData（平台惯例目录，见 data-dir.ts）：与偏好同级。
  // 目录名不能是 `cache`——Chromium 的 HTTP 缓存在 `userData/Cache`，
  // 大小写不敏感卷上会撞成同一个目录，清缓存会连带删掉链接图字节。
  return join(app.getPath("userData"), IMAGE_CACHE_DIRNAME);
}

/** `userData/image-cache/<key>.{bin,json}` */
function cachePaths(key: string): { bin: string; meta: string } {
  const dir = cacheDir();
  return { bin: join(dir, `${key}.bin`), meta: join(dir, `${key}.json`) };
}

function keyOf(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 24);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // AbortError 的消息是 "This operation was aborted"，对用户不够直白
    if (error.name === "AbortError") return "请求超时";
    return error.message;
  }
  return String(error);
}

function isHttpUrl(raw: string): URL | null {
  return parseHttpUrl(raw);
}

function isLinkLocalAddress(address: string): boolean {
  return linkLocal(address);
}

/**
 * 解析目标主机（域名可能指向 169.254.x.x，必须按解析结果再判一次）。
 *
 * 已知窗口：这里查到的 IP 与真正建连之间可能被 DNS 重绑定换掉（TOCTOU）。
 * 桌面单机、URL 由用户或 agent 主动给出，风险可接受；要彻底堵死得自己建 socket
 * 锁定 IP，会破坏 SNI 与证书校验，不做。
 */
async function assertHostAllowed(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`无法解析域名 ${host}`);
  }
  if (addresses.some((entry) => isLinkLocalAddress(entry.address))) {
    throw new Error("不允许访问链路本地地址");
  }
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[]>;
  bytes: Uint8Array;
}

type RawResult = ({ kind: "response" } & RawResponse) | { kind: "redirect"; location: string };

const MAX_IMAGE_LABEL = `${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`;

function headerOf(headers: Record<string, string | string[]>, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * 发一个请求（不跟随重定向）。
 *
 * 用 `net.request` 而不是 `net.fetch`：实测（Electron 45）`net.fetch` 的
 * `redirect: "manual"` 会直接取消请求并 reject（"Redirect was cancelled"），
 * 自动跟随时又**不填** `response.redirected` / `response.url`，拿不到最终地址。
 * `net.request` 在 manual 下会发 `redirect` 事件并给出绝对地址，可以逐跳校验。
 */
function requestOnce(url: URL, headers: Record<string, string>, deadline: number): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url: url.toString(), redirect: "manual" });
    for (const [key, value] of Object.entries(headers)) request.setHeader(key, value);

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        request.abort();
        reject(new Error("请求超时"));
      });
    }, Math.max(1, deadline - Date.now()));

    request.on("redirect", (_status, _method, location) => {
      finish(() => resolve({ kind: "redirect", location }));
    });

    request.on("response", (response) => {
      const declared = Number(headerOf(response.headers, "content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        finish(() => {
          request.abort();
          reject(new Error(`图片超过 ${MAX_IMAGE_LABEL} 上限`));
        });
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_IMAGE_BYTES) {
          finish(() => {
            request.abort();
            reject(new Error(`图片超过 ${MAX_IMAGE_LABEL} 上限`));
          });
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        finish(() =>
          resolve({
            kind: "response",
            status: response.statusCode,
            headers: response.headers,
            bytes: new Uint8Array(Buffer.concat(chunks, total)),
          }),
        );
      });
      response.on("error", (error) => finish(() => reject(error)));
    });

    request.on("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

/**
 * 请求一张图：逐跳跟随重定向（最多 3 跳），每一跳都重新校验主机。
 * 整条链共用一个超时预算。
 */
async function requestImage(url: URL, headers: Record<string, string>): Promise<RawResponse> {
  const deadline = Date.now() + TIMEOUT_MS;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertHostAllowed(current);
    const result = await requestOnce(current, headers, deadline);
    if (result.kind === "response") return result;
    const next = isHttpUrl(result.location);
    if (!next) throw new Error("重定向到了不支持的地址");
    logApp("warn", "image url redirected", { from: current.toString(), to: next.toString() });
    current = next;
  }
  throw new Error("重定向次数过多");
}

async function readMeta(path: string): Promise<CacheMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CacheMeta>;
    if (typeof parsed.url !== "string" || typeof parsed.contentType !== "string") return null;
    return {
      url: parsed.url,
      contentType: parsed.contentType,
      etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
      lastModified: typeof parsed.lastModified === "string" ? parsed.lastModified : undefined,
      lastUsedAt: typeof parsed.lastUsedAt === "number" ? parsed.lastUsedAt : 0,
    };
  } catch {
    return null;
  }
}

async function readCached(paths: { bin: string; meta: string }, meta: CacheMeta): Promise<Uint8Array | null> {
  try {
    const bytes = new Uint8Array(await readFile(paths.bin));
    // 最近使用时间：一小时最多刷一次，别让每次读都变成写盘
    const now = Date.now();
    if (now - meta.lastUsedAt > TOUCH_INTERVAL_MS) {
      await utimes(paths.bin, new Date(now), new Date(now)).catch(() => undefined);
      await writeFile(paths.meta, JSON.stringify({ ...meta, lastUsedAt: now }), "utf8").catch(() => undefined);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function writeCache(paths: { bin: string; meta: string }, meta: CacheMeta, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(paths.bin), { recursive: true });
  // 先写临时文件再改名：崩在中间也不会留下半张图；序号避免并发写共用同一个 tmp
  const tmp = `${paths.bin}.${process.pid}.${++tempSeq}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, paths.bin);
  await writeFile(paths.meta, JSON.stringify({ ...meta, lastUsedAt: Date.now() }), "utf8");
  await enforceCacheCap();
}

/** 超过总上限时按最近使用时间淘汰最旧的文件（bin 的 mtime 就是 lastUsedAt）。 */
async function enforceCacheCap(): Promise<void> {
  const dir = cacheDir();
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".bin"));
  } catch {
    return;
  }
  let total = 0;
  const entries: { name: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    try {
      const info = await stat(join(dir, name));
      total += info.size;
      entries.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // 文件刚被删：跳过
    }
  }
  if (total <= MAX_CACHE_BYTES) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= MAX_CACHE_BYTES) break;
    const stem = entry.name.slice(0, -".bin".length);
    await unlink(join(dir, entry.name)).catch(() => undefined);
    await unlink(join(dir, `${stem}.json`)).catch(() => undefined);
    total -= entry.size;
  }
}

function ok(bytes: Uint8Array, contentType: string, stale: boolean): FetchImageResult {
  return { ok: true, bytes, contentType, stale };
}

/** 读响应体、写缓存并返回结果。 */
async function persist(
  response: RawResponse,
  paths: { bin: string; meta: string },
  url: string,
  started: number,
): Promise<FetchImageResult> {
  const bytes = response.bytes;
  if (bytes.length === 0) throw new Error("服务器返回空内容");
  const contentType = headerOf(response.headers, "content-type") ?? "application/octet-stream";
  await writeCache(paths, {
    url,
    contentType,
    etag: headerOf(response.headers, "etag") ?? undefined,
    lastModified: headerOf(response.headers, "last-modified") ?? undefined,
    lastUsedAt: Date.now(),
  }, bytes);
  logApp("info", "image fetched", { url, bytes: bytes.length, ms: Date.now() - started });
  return ok(bytes, contentType, false);
}

/**
 * 取一张远程图片的字节：缓存优先，每个 URL 每会话校验一次。
 * 抓取失败时回退到上一次缓存（`stale: true`），连缓存都没有才失败。
 */
export async function fetchRemoteImage(raw: string, force = false): Promise<FetchImageResult> {
  const url = isHttpUrl(raw);
  if (!url) return { ok: false, reason: "只支持 http/https 图片地址" };

  const normalized = url.toString();
  const key = keyOf(normalized);
  const paths = cachePaths(key);
  const meta = await readMeta(paths.meta);
  const cached = meta ? await readCached(paths, meta) : null;

  // 本会话已经校验过：直接用缓存，不再打网络（用户点「重新抓取」时除外）
  if (cached && !force && revalidated.has(key)) return ok(cached, meta!.contentType, false);

  const started = Date.now();
  const headers: Record<string, string> = { Accept: "image/*", "User-Agent": IMAGE_UA };
  if (!force && meta?.etag) headers["If-None-Match"] = meta.etag;
  else if (!force && meta?.lastModified) headers["If-Modified-Since"] = meta.lastModified;

  try {
    revalidated.add(key);
    const response = await requestImage(url, headers);
    if (response.status === 304) {
      if (cached && meta) {
        logApp("info", "image not modified", { url: normalized, ms: Date.now() - started });
        return ok(cached, meta.contentType, false);
      }
      // 条件请求说有缓存，但缓存文件被清掉了：去掉条件头重新抓一次
      const fresh = await requestImage(url, { Accept: "image/*" });
      if (fresh.status < 200 || fresh.status >= 300) throw new Error(`服务器返回 ${fresh.status}`);
      return await persist(fresh, paths, normalized, started);
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`服务器返回 ${response.status}`);
    return await persist(response, paths, normalized, started);
  } catch (error) {
    const reason = messageOf(error);
    if (cached) {
      // 断网/404/超时：用上一次的缓存，画布不报错
      logApp("warn", "image fetch failed, using cache", { url: normalized, error: reason });
      return ok(cached, meta!.contentType, true);
    }
    logApp("warn", "image fetch failed", { url: normalized, error: reason });
    return { ok: false, reason: `抓取图片失败：${reason}` };
  }
}

/** 缓存占用的字节数（设置/排障用）。 */
export async function imageCacheBytes(): Promise<number> {
  const dir = cacheDir();
  let total = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".bin")) continue;
      try {
        total += (await stat(join(dir, name))).size;
      } catch {
        // 忽略并发删除
      }
    }
  } catch {
    return 0;
  }
  return total;
}

/** 清空图片缓存：下次渲染会重新抓。返回删掉的字节数。 */
export async function clearImageCache(): Promise<number> {
  const before = await imageCacheBytes();
  await rm(cacheDir(), { recursive: true, force: true });
  revalidated.clear();
  logApp("info", "image cache cleared", { bytes: before });
  return before;
}

export function registerImageCacheChannels(): void {
  ipcMain.handle(CHANNELS.appFetchImage, async (_event, url: string, options?: { force?: boolean }): Promise<FetchImageResult> => {
    if (typeof url !== "string") return { ok: false, reason: "图片地址必须是字符串" };
    return fetchRemoteImage(url, Boolean(options?.force));
  });
  ipcMain.handle(CHANNELS.appClearImageCache, async () => ({ bytes: await clearImageCache() }));
}
