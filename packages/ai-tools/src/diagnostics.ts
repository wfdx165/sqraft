/** 写工具出口的诊断接线：取事务 changed、跑 core 的 diagnose、合并进返回体。 */

import type { DocStore, MeasureText, NodeId } from "@sqraft/core";
import { NUMERIC_TOKEN_CHANGED, diagnose } from "@sqraft/core";
export function attachDiagnostics(
  store: DocStore,
  raw: string,
  changed: Set<NodeId>,
  measureLine?: MeasureText,
): string {
  // Token 命令只标 __doc__：扫全文档，但只跑 TOKEN_MISSING，避免把无关的历史问题带出来
  const docLevel =
    changed.has("__doc__" as NodeId) || changed.has(NUMERIC_TOKEN_CHANGED as NodeId);
  // 写工具：changed 已含每个被动的节点（create / 实例物化 / 布局回写都会逐个加进去），
  // 只查这些节点自身即可；把父容器也下探会重报同容器里的历史问题。
  const roots = docLevel
    ? [...store.doc.rootIds]
    : [...changed].filter((id) => Boolean(store.doc.nodes[id]));
  if (roots.length === 0) return raw;
  const result = diagnose(store.doc, roots, {
    measure: measureLine,
    shallow: !docLevel,
    codes: docLevel ? ["TOKEN_MISSING"] : undefined,
  });
  if (result.diagnostics.length === 0) return raw;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  return JSON.stringify({
    ...parsed,
    diagnostics: result.diagnostics,
    ...(result.truncated ? { diagnosticsTruncated: true } : {}),
  });
}
