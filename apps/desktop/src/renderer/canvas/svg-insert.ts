/**
 * 把一份 SVG 源插成页面里的 frame（GUI 拖入与 agent `import_svg` 共用）。
 * 解析失败 → fallback（调用方决定按图片插入还是报错）；成功时整份一个撤销步。
 */
import { createNode, type NodeId } from "@sqraft/core";
import type { SvgImportFailureReason, SvgImportWarning } from "@sqraft/ai-tools";
import { docStore } from "../store";
import { parseSvg } from "./svg-import";

export interface SvgInsertResult {
  frameId: NodeId;
  width: number;
  height: number;
  rasterized: string[];
  missingFonts: string[];
  warnings: SvgImportWarning[];
}

export type SvgInsertOutcome =
  | { status: "ok"; result: SvgInsertResult }
  | { status: "fallback"; reason: SvgImportFailureReason; limit?: number; warnings: SvgImportWarning[] }
  | { status: "error"; message: string };

export interface SvgInsertRequest {
  text: string;
  name: string;
  pageId: NodeId;
  /** 页面坐标系里的落点；省略时居中到页面 */
  x?: number;
  y?: number;
}

export async function insertSvgFrame(request: SvgInsertRequest): Promise<SvgInsertOutcome> {
  const page = docStore.doc.nodes[request.pageId];
  if (!page || page.type !== "page") return { status: "error", message: "page not found" };

  const outcome = await parseSvg(request.text);
  if (outcome.status === "fallback") return outcome;
  const { width, height, nodes, rasterized, missingFonts, warnings } = outcome.result;

  const x = request.x ?? Math.round(page.x + (page.width - width) / 2);
  const y = request.y ?? Math.round(page.y + (page.height - height) / 2);
  const frame = createNode("frame", {
    name: request.name.replace(/\.svg$/i, "") || "SVG",
    parentId: page.id,
    x,
    y,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    clip: true,
    style: {},
  });
  for (const node of nodes) node.parentId = frame.id;
  frame.children = nodes.map((node) => node.id);
  // 一个 SVG 一个撤销步（root + 全部子节点一次创建）
  docStore.apply({ type: "node.create", params: { nodes: [frame, ...nodes], parentId: page.id } }, "导入 SVG");
  return {
    status: "ok",
    result: { frameId: frame.id, width: frame.width, height: frame.height, rasterized, missingFonts, warnings },
  };
}
