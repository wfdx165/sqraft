/**
 * 冲突判定（纯函数）：现有 `sqraft` 条目与我们想写的内容是什么关系。
 *
 * 规则来自 ADR-0036：只覆盖「确认是自己写的」条目；认不出的同名条目一律不动，
 * 交给用户在 UI 里显式替换。
 */

export type ConflictAction =
  /** 已经是我们想要的地址：不动文件，补清单 */
  | "skip-same"
  /** 没有条目，或条目归我们管：写入 / 更新 */
  | "update"
  /** 清单外，但指向本机 Sqraft 端点：当作历史遗留，覆盖 */
  | "adopt"
  /** 认不出的同名条目：不写，等用户显式替换 */
  | "conflict";

export interface ConflictInput {
  exists: boolean;
  /** 现有条目里的 url；没有 url（例如 stdio 命令）时为 null */
  existingUrl: string | null;
  desiredUrl: string;
  /** 所有权清单里是否有这个客户端 */
  owned: boolean;
}

/** 只认 `http://127.0.0.1:<port>/mcp`；localhost / IPv6 / 带凭据或查询一律不算，避免误伤其它本机工具。 */
export function isSqraftLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/mcp") return false;
    // userinfo / query / hash 都不是 Sqraft 写出来的形状
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port >= 1024 && port <= 65535;
  } catch {
    return false;
  }
}

export function decideConflict(input: ConflictInput): ConflictAction {
  if (!input.exists) return "update";
  if (input.existingUrl === input.desiredUrl) return "skip-same";
  if (input.owned) return "update";
  if (input.existingUrl && isSqraftLoopbackUrl(input.existingUrl)) return "adopt";
  return "conflict";
}
