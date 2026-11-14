/**
 * 打开文档的一次性取件凭证（纯逻辑，不依赖 Electron，便于测试）。
 *
 * 大文档（上 GB）经 `ipcRenderer.invoke` 整块传给渲染层要做一次结构化克隆，实测 1–4 秒。
 * 改成：主进程只登记"这个文件允许读一次"，渲染层用 `fetch(sqraft-doc://file/<token>)` 流式取回。
 * 凭证是 128 位随机数、**只能用一次**、60 秒过期——协议只能读主进程刚刚为"打开文件"登记过的路径，
 * 不能被拿来读任意文件。
 */

import { randomBytes } from "node:crypto";

export interface StagedDocument {
  path: string;
  size: number;
}

export interface DocStaging {
  /** 登记一个文件，返回凭证 */
  stage(doc: StagedDocument): string;
  /** 取走凭证对应的文件（取一次就作废；不存在或过期返回 null） */
  take(token: string): StagedDocument | null;
}

export const DOC_STAGING_TTL_MS = 60_000;

export function createDocStaging(now: () => number = Date.now): DocStaging {
  const staged = new Map<string, StagedDocument & { expires: number }>();
  const sweep = () => {
    const t = now();
    for (const [token, entry] of staged) if (entry.expires <= t) staged.delete(token);
  };
  return {
    stage(doc) {
      sweep();
      const token = randomBytes(16).toString("hex");
      staged.set(token, { ...doc, expires: now() + DOC_STAGING_TTL_MS });
      return token;
    },
    take(token) {
      sweep();
      const entry = staged.get(token);
      if (!entry) return null;
      staged.delete(token);
      return { path: entry.path, size: entry.size };
    },
  };
}
