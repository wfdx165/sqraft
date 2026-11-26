/**
 * 布尔运算与转路径的 agent 入口。
 *
 * 几何与命令都在 core（`boolean.*` / `node.convertToPath`，ADR-0040）；
 * 这里只负责参数校验、生成 resultId，以及把"样式来自谁 / 颜色是否被合并"讲清楚。
 */

import type { BooleanOp, DocState, NodeStyle } from "@sqraft/core";
import { inspectBooleanSelection, newId, resolvePaintSpec } from "../shared";
import type { Handler } from "../types";

const OPS: ReadonlySet<string> = new Set(["union", "subtract", "intersect", "exclude"]);

function readIds(value: unknown, field: string, min: number): string[] {
  if (!Array.isArray(value) || value.length < min) throw new Error(`${field} 至少需要 ${min} 个节点 id`);
  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !raw) throw new Error(`${field} 只能包含节点 id 字符串`);
    if (!ids.includes(raw)) ids.push(raw);
  }
  return ids;
}

function styleKey(doc: DocState, style: NodeStyle): string {
  return JSON.stringify([resolvePaintSpec(doc, style.fill) ?? null, resolvePaintSpec(doc, style.stroke) ?? null]);
}

/** `boolean_op`：结果烘焙成普通 path，操作数只留在撤销栈里。 */
export const handleBooleanOp: Handler = async (ctx, args) => {
  const op = String(args.op);
  if (!OPS.has(op)) throw new Error("op 必须是 union / subtract / intersect / exclude");
  const nodeIds = readIds(args.nodeIds, "nodeIds", 2);
  // 命令执行后操作数就没了，样式来源要在 apply 之前算
  const selection = inspectBooleanSelection(ctx.store.doc, nodeIds, op as BooleanOp);
  const mergedStyles =
    new Set(selection.operands.map((node) => styleKey(ctx.store.doc, node.style))).size > 1;
  const resultId = newId();
  const type = `boolean.${op}` as
    | "boolean.union"
    | "boolean.subtract"
    | "boolean.intersect"
    | "boolean.exclude";
  ctx.store.apply({ type, params: { nodeIds, resultId } }, `ai:boolean-${op}`);
  const result = ctx.store.doc.nodes[resultId];
  const anchorCount = result?.vector?.contours.reduce((sum, contour) => sum + contour.anchors.length, 0) ?? 0;
  return JSON.stringify({
    ok: true,
    nodeId: resultId,
    op,
    styleFrom: { nodeId: selection.baseline.id, name: selection.baseline.name },
    ...(mergedStyles ? { mergedStyles: true } : {}),
    anchorCount,
  });
};

/** `convert_to_path`：原地换类型，id 不变。 */
export const handleConvertToPath: Handler = async (ctx, args) => {
  const nodeIds = readIds(args.nodeIds, "nodeIds", 1);
  ctx.store.apply({ type: "node.convertToPath", params: { nodeIds } }, "ai:convert-to-path");
  return JSON.stringify({ ok: true, nodeIds });
};
