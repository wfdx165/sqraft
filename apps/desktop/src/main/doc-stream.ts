/**
 * `sqraft-doc://file/<token>`：把刚打开的文档流式交给渲染层（替代 IPC 整块克隆，见 doc-staging.ts）。
 */

import { protocol } from "electron";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { createDocStaging } from "./doc-staging";
import { logApp } from "./mcp/log";

export const DOC_SCHEME = "sqraft-doc";

const staging = createDocStaging();

/** 必须在 app ready 之前调用。 */
export function registerDocSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    // corsEnabled：页面源（dev 的 localhost / 打包后的 file://）跨源 fetch 需要
    { scheme: DOC_SCHEME, privileges: { supportFetchAPI: true, stream: true, corsEnabled: true, secure: true } },
  ]);
}

export function registerDocProtocol(): void {
  protocol.handle(DOC_SCHEME, (request) => {
    const token = new URL(request.url).pathname.replace(/^\/+/, "");
    const doc = staging.take(token);
    if (!doc) {
      logApp("warn", "doc-stream: unknown or expired token");
      return new Response(null, { status: 404 });
    }
    const body = Readable.toWeb(createReadStream(doc.path, { highWaterMark: 8 * 1024 * 1024 })) as ReadableStream;
    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(doc.size),
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
    });
  });
}

/** 登记一个要打开的文件：返回渲染层取件用的 URL 与文件信息（不读内容）。 */
export async function stageDocument(path: string): Promise<{ path: string; name: string; mtimeMs: number; size: number; url: string }> {
  const info = await stat(path);
  const token = staging.stage({ path, size: info.size });
  return { path, name: basename(path), mtimeMs: info.mtimeMs, size: info.size, url: `${DOC_SCHEME}://file/${token}` };
}
