/**
 * 导出文件名（纯函数，便于单测）：`<文档名>-<对象名>.<ext>`。
 */
import type { DocState, NodeId } from "@sqraft/core";
import { t } from "./i18n";

const ILLEGAL = /[\\/:*?"<>|]/g;

/** 导出目标：整页（没有 nodeIds）或选中的若干节点。 */
export interface ExportNameTarget {
  pageId: NodeId | null;
  nodeIds?: readonly NodeId[];
}

/** 导出对象名：单选取节点名，整页取页面名，多选不带。 */
export function exportObjectName(doc: DocState, target: ExportNameTarget): string {
  if (target.nodeIds?.length === 1) return doc.nodes[target.nodeIds[0]]?.name ?? "";
  if (!target.nodeIds?.length && target.pageId) return doc.nodes[target.pageId]?.name ?? "";
  return "";
}

/** 文件名里不能出现的字符（Windows 与 macOS 的并集）换成连字符。 */
export function exportFileName(
  docName: string,
  objectName: string,
  ext: "png" | "svg",
  /** PNG 的导出倍率：文件名带上 @1 / @2 / @4，SVG 始终不带 */
  scale = 1,
): string {
  const doc = docName.replace(/\.sqraft$/i, "").trim() || t("common.untitled");
  const object = objectName.replace(ILLEGAL, "-").replace(/\s+/g, " ").trim().slice(0, 80);
  const suffix = ext === "png" ? `@${scale}` : "";
  return object ? `${doc}-${object}${suffix}.${ext}` : `${doc}${suffix}.${ext}`;
}
