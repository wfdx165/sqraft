/** 下载更新包并校验 sha256：写 `.part`，校验通过才改名，失败不留半截文件。 */
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

/**
 * 手动跟随重定向：每一跳都要过白名单，避免 GitHub 之外的地址把请求接走。
 * fetch 的自动跟随只能看终点，中间跳过一次就失去了校验机会。
 */
async function openStream(url: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isTrustedUpdateUrl(current)) throw new Error(t("update.downloadUrlNotAllowed", { url: current }));
    const response = await fetch(current, {
      redirect: "manual",
      // 整包上限 10 分钟：信号会跟着响应体走，不能用"只等响应头"的超时
      signal: AbortSignal.timeout(10 * 60_000),
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

  const response = await openStream(request.url);
  const lengthHeader = response.headers.get("content-length");
  const total = request.size ?? (lengthHeader ? Number.parseInt(lengthHeader, 10) : null) ?? null;
  if (!response.body) throw new Error(t("update.noBody"));

  const hash = createHash("sha256");
  let received = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      request.onProgress?.(received, total);
      callback(null, chunk);
    },
  });

  try {
    // 主进程是 Node 环境：web stream 转 Node stream，边下边算哈希，不把 120MB 全放进内存
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), tap, createWriteStream(part));
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }

  if (total !== null && received !== total) {
    await rm(part, { force: true });
    throw new Error(t("update.incomplete", { total, received }));
  }
  const digest = hash.digest("hex");
  if (digest.toLowerCase() !== request.sha256.toLowerCase()) {
    await rm(part, { force: true });
    throw new Error(t("update.shaMismatch"));
  }
  await rename(part, request.dest);
}
