/**
 * 详情浮层的行数裁剪（纯函数，便于单测）。
 * 默认只列 5 行，其余只报数量、不提供展开入口。
 */
export const CONNECTION_VISIBLE_LIMIT = 5;

export function visibleClients<T>(
  clients: readonly T[],
  limit = CONNECTION_VISIBLE_LIMIT,
): { rows: T[]; more: number } {
  const capped = Math.max(0, Math.floor(limit));
  return { rows: clients.slice(0, capped), more: Math.max(0, clients.length - capped) };
}
