/**
 * 更新相关的对外链接（纯函数，便于测试）。
 *
 * `incompatible` 打开 Releases 列表，而不是 `/releases/latest`：
 * 最新版正是当前系统装不上的那个，用户在列表里找最后一个兼容版本。
 */
import type { UpdateState } from "../../shared/ipc";

export function releasePageUrl(repo: string, phase: UpdateState["phase"]): string {
  const base = `https://github.com/${repo}/releases`;
  return phase === "incompatible" ? base : `${base}/latest`;
}
