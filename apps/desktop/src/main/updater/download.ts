/**
 * 下载更新包并校验 sha256：写 `.part`，校验通过才改名，失败不留半截文件。
 *
 * 超时分三档（ADR-0029）：连接 60 秒、空闲 60 秒、总时长 60 分钟。
 * 原来的"总 10 分钟"在慢网下会把一个正在正常推进的 120MB 下载整体掐掉；
 * 空闲超时只看"有没有数据进来"，慢但不停就不会失败。
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isTrustedUpdateUrl } from "./protocol";
import { t } from "../i18n";

export interface DownloadRequest {
  url: string;
  dest: string;
  sha256: string;
  /** 期望体积（可选）：用来在下载前提醒磁盘空间，也用于进度分母。 */
  size?: number;
  onProgress?: (received: number, total: number | null) => void;
}

const MAX_REDIRECTS = 5;

/** 等响应头（含逐跳重定向）的上限 */
const CONNECT_TIMEOUT_MS = 60_000;
/** 数据流静默上限：慢网只要还在进数据就不算失败 */
const IDLE_TIMEOUT_MS = 60_000;
/** 硬上限：极端情况下（每次只进来几字节）也不无限挂着 */
const HARD_CAP_MS = 60 * 60_000;

export interface DownloadTimeouts {
  connect: number;
  idle: number;
  hardCap: number;
}

/**
 * 下载的三档超时。抽成独立对象是为了能在 Node 下用假时钟直接测，
 * 不用起网络；`abort(reason)` 把友好文案挂到 signal 上，供调用方映射。
 */
export class DownloadWatchdog {
  private readonly controller = new AbortController();
  private readonly timeouts: DownloadTimeouts;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private failureReason: Error | null = null;

  constructor(timeouts: Partial<DownloadTimeouts> = {}) {
    this.timeouts = { connect: CONNECT_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS, hardCap: HARD_CAP_MS, ...timeouts };
    this.connectTimer = setTimeout(() => this.abort(t("update.connectTimeout")), this.timeouts.connect);
    this.capTimer = setTimeout(() => this.abort(t("update.downloadTimeout")), this.timeouts.hardCap);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 这次超时的原因（没超时为 null）；调用方用它替换底层的 AbortError 文案。 */
  get failure(): Error | null {
    return this.failureReason;
  }

  /** 响应头到了：连接阶段结束，开始算空闲时间。 */
  connected(): void {
    if (this.failureReason) return;
    this.clearConnect();
    this.touch();
  }

  /** 收到数据：重置空闲计时。 */
  touch(): void {
    if (this.failureReason) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.abort(t("update.idleTimeout")), this.timeouts.idle);
  }

  dispose(): void {
    this.clearConnect();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.capTimer) {
      clearTimeout(this.capTimer);
      this.capTimer = null;
    }
  }

  private clearConnect(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private abort(message: string): void {
    if (this.failureReason) return;
    this.failureReason = new Error(message);
    this.dispose();
    this.controller.abort(this.failureReason);
  }
}

/**
 * 手动跟随重定向：每一跳都要过白名单，避免 GitHub 之外的地址把请求接走。
 * fetch 的自动跟随只能看终点，中间跳过一次就失去了校验机会。
 */
async function openStream(url: string, watchdog: DownloadWatchdog): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isTrustedUpdateUrl(current)) throw new Error(t("update.downloadUrlNotAllowed", { url: current }));
    const response = await fetch(current, {
      redirect: "manual",
      signal: watchdog.signal,
      headers: { accept: "application/octet-stream" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(t("update.redirectNoTarget", { status: response.status }));
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(t("update.downloadHttp", { status: response.status }));
    return response;
  }
  throw new Error(t("update.tooManyRedirects"));
}

export async function downloadVerified(request: DownloadRequest): Promise<void> {
  await mkdir(dirname(request.dest), { recursive: true });
  const part = `${request.dest}.part`;
  await rm(part, { force: true });

  const watchdog = new DownloadWatchdog();
  try {
    const response = await openStream(request.url, watchdog);
    watchdog.connected();

    const lengthHeader = response.headers.get("content-length");
    const total = request.size ?? (lengthHeader ? Number.parseInt(lengthHeader, 10) : null) ?? null;
    if (!response.body) throw new Error(t("update.noBody"));

    const hash = createHash("sha256");
    let received = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        received += chunk.length;
        watchdog.touch();
        request.onProgress?.(received, total);
        callback(null, chunk);
      },
    });

    // 主进程是 Node 环境：web stream 转 Node stream，边下边算哈希，不把 120MB 全放进内存
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), tap, createWriteStream(part));
    // 响应体已经收完：后面的哈希与改名不该再被 60 分钟硬上限掐掉
    watchdog.dispose();

    if (total !== null && received !== total) {
      throw new Error(t("update.incomplete", { total, received }));
    }
    const digest = hash.digest("hex");
    if (digest.toLowerCase() !== request.sha256.toLowerCase()) {
      throw new Error(t("update.shaMismatch"));
    }
    await rename(part, request.dest);
  } catch (error) {
    await rm(part, { force: true });
    // 超时抛的是底层 AbortError，换成带原因的中文文案
    throw watchdog.failure ?? error;
  } finally {
    watchdog.dispose();
  }
}
