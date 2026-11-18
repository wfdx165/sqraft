/**
 * 面板的额外数据源：页面、图层、Token、最近文件。
 *
 * 纯函数只负责收集与打分；扫描时机（防抖、当前页 / 全文）在组件里决定。
 */
import type { DocState, NodeId } from "@sqraft/core";
import { scoreLabel } from "./palette-search";

export type SourceKind = "page" | "layer" | "token" | "file";

export interface SourceItem {
  kind: SourceKind;
  /** 页面/节点 id、Token 路径或文件路径 */
  id: string;
  label: string;
  hint: string;
  locked?: boolean;
  hidden?: boolean;
}

export interface RankedSource extends SourceItem {
  score: number;
}

const KIND_ORDER: Record<SourceKind, number> = { page: 0, layer: 1, token: 2, file: 3 };

/** 打分、过滤 0 分、按 kind → label 排序并截断。 */
export function rankSources(query: string, items: readonly SourceItem[], limit = 50): RankedSource[] {
  const scored: RankedSource[] = [];
  for (const item of items) {
    const score = scoreLabel(query, item.label);
    if (score > 0) scored.push({ ...item, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.label.localeCompare(b.label),
  );
  return scored.slice(0, limit);
}

/** 页面顺序与文档一致；没有名字的页面用占位。 */
export function collectPageItems(doc: DocState): SourceItem[] {
  return doc.rootIds.flatMap((id) => {
    const node = doc.nodes[id];
    if (!node || node.type !== "page") return [];
    return [{ kind: "page" as const, id, label: node.name || "Page", hint: "" }];
  });
}

const MAX_LAYER_CANDIDATES = 2000;

/**
 * 图层候选：`page` 模式只扫活动页子树；`document` 模式扫全文档（含组件母版）。
 * 跳过页面与匿名节点；候选上限只防极端文档，结果排序在 rankSources。
 */
export function collectLayerItems(
  doc: DocState,
  activePageId: NodeId | null,
  mode: "page" | "document",
): SourceItem[] {
  const out: SourceItem[] = [];
  if (mode === "page") {
    const page = activePageId ? doc.nodes[activePageId] : null;
    if (!page) return out;
    const stack = [...page.children];
    while (stack.length > 0 && out.length < MAX_LAYER_CANDIDATES) {
      const id = stack.pop()!;
      const node = doc.nodes[id];
      if (!node) continue;
      if (node.type !== "page" && node.name) out.push(layerItem(doc, node.id, node.name, node.locked, !node.visible));
      if (node.children.length > 0) stack.push(...node.children);
    }
    return out;
  }

  for (const node of Object.values(doc.nodes)) {
    if (out.length >= MAX_LAYER_CANDIDATES) break;
    if (node.type === "page" || !node.name) continue;
    out.push(layerItem(doc, node.id, node.name, node.locked, !node.visible));
  }
  return out;
}

function layerItem(
  doc: DocState,
  id: NodeId,
  label: string,
  locked: boolean,
  hidden: boolean,
): SourceItem {
  return { kind: "layer", id, label, hint: parentHint(doc, id), locked, hidden };
}

/** 父级名称链（最多 3 层，从远到近）。 */
function parentHint(doc: DocState, nodeId: NodeId): string {
  const names: string[] = [];
  let parent = doc.nodes[nodeId]?.parentId ?? null;
  while (parent && names.length < 3) {
    const node = doc.nodes[parent];
    if (!node) break;
    if (node.type !== "page" && node.name) names.unshift(node.name);
    parent = node.parentId;
  }
  return names.join(" / ");
}

export function collectTokenItems(doc: DocState): SourceItem[] {
  return Object.entries(doc.tokens).map(([path, entry]) => ({
    kind: "token" as const,
    id: path,
    label: path,
    hint: entry.type === "color" ? String(entry.value) : `${entry.value}`,
  }));
}
