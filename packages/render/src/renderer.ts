/**
 * 渲染器：每帧从 DocumentStore 拉取当前状态，深度优先 z 序绘制。
 * 渲染层无文档缓存（architecture.md §5）。
 */

import type { DocNode, DocState, NodeId } from "@sqraft/core";
import { resolvePaint } from "@sqraft/core";
import type { RenderBackend, RenderContext, Viewport } from "./backend";

const CONTAINER_TYPES = new Set(["page", "frame", "group"]);

function drawNode(backend: RenderBackend, ctx: RenderContext, node: DocNode, isRootChild: boolean): void {
  if (!node.visible) return;
  const fill = resolvePaint(ctx.doc, node.style.fill);
  const stroke = resolvePaint(ctx.doc, node.style.stroke);
  switch (node.type) {
    case "rect":
    case "component":
      backend.drawRect(node, fill, stroke, node.style.strokeWidth, node.style.cornerRadius ?? 0);
      break;
    case "frame":
      backend.drawRect(node, "#ffffff", "rgba(0,0,0,0.15)", 1, node.style.cornerRadius ?? 0);
      if (isRootChild) backend.drawFrameOutline(node);
      break;
    case "ellipse":
      backend.drawEllipse(node, fill, stroke, node.style.strokeWidth);
      break;
    case "line":
      backend.drawLine(node, stroke ?? "#000", node.style.strokeWidth ?? 1);
      break;
    case "text":
      backend.drawText(node, fill ?? "#000");
      break;
    case "instance":
      backend.drawRect(node, fill ?? "transparent", "rgba(51,102,255,0.6)", 1, node.style.cornerRadius ?? 0);
      break;
    default:
      if (CONTAINER_TYPES.has(node.type)) {
        // page/group 不画自身
      } else {
        backend.drawRect(node, fill, stroke, node.style.strokeWidth, node.style.cornerRadius ?? 0);
      }
  }
  // 容器子节点按 z 序递归（骨架：暂不应用自动布局位移，M2 接入 solveLayout）
  for (const childId of node.children) {
    const child = ctx.doc.nodes[childId];
    if (child) drawNode(backend, ctx, child, false);
  }
}

export function renderDocument(
  backend: RenderBackend,
  doc: DocState,
  vp: Viewport,
  rootId: NodeId,
): void {
  const ctx: RenderContext = {
    doc,
    resolveColor: (p) => resolvePaint(doc, p),
  };
  backend.beginFrame(vp);
  const root = doc.nodes[rootId];
  if (root) {
    for (const childId of root.children) {
      const child = doc.nodes[childId];
      if (child) drawNode(backend, ctx, child, true);
    }
  }
  backend.endFrame();
}
