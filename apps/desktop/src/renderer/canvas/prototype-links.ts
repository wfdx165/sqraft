/**
 * 原型链接的画布提示（纯 UI 叠加层）：选中或悬停热区时，画出到目标页面的连线，
 * 或退化成「→ 页面名」的胶囊。不进文档、不进导出、不进 AI 截图。
 *
 * 目标页不在视口里时不画长线（会横穿整个画布），只给胶囊，避免视觉噪音。
 */
import { worldRect, walkSubtree, type DocState, type NodeId, type Rect } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { t } from "../i18n";
import { labelFont } from "./label-metrics";

const LINE = "rgba(37, 99, 235, 0.7)";
const FLOW_LINE = "rgba(37, 99, 235, 0.3)";
const CHIP_BG = "rgba(37, 99, 235, 0.92)";
const CHIP_TEXT = "#ffffff";
const CHIP_PAD_X = 7;
const CHIP_HEIGHT = 18;
const CHIP_RADIUS = 5;
const ARROW = 5;
const EDGE = 4;
/** 流向图最多画多少条：防御病态文档，正常稿子远达不到 */
export const FLOW_LIMIT = 200;

export interface PrototypeLinkOptions {
  doc: DocState;
  vp: Viewport;
  /** 要检查的热区（选区 + 悬停），内部去重；没有 click 交互的跳过 */
  nodeIds: readonly NodeId[];
}

/** 目标页是否与视口相交（视口宽高是 CSS 像素，世界宽度要除以 zoom）。 */
export function targetVisible(vp: Viewport, rect: Rect): boolean {
  return (
    rect.x + rect.width > vp.x &&
    rect.x < vp.x + vp.width / vp.zoom &&
    rect.y + rect.height > vp.y &&
    rect.y < vp.y + vp.height / vp.zoom
  );
}

function chipWidth(ctx: CanvasRenderingContext2D, text: string): number {
  ctx.font = labelFont();
  return Math.ceil(ctx.measureText(text).width) + CHIP_PAD_X * 2;
}

function drawChip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, vp: Viewport): void {
  const width = chipWidth(ctx, text);
  const left = Math.min(Math.max(EDGE, x), Math.max(EDGE, vp.width - width - EDGE));
  const top = Math.max(EDGE, y);
  ctx.fillStyle = CHIP_BG;
  ctx.beginPath();
  ctx.roundRect(left, top, width, CHIP_HEIGHT, CHIP_RADIUS);
  ctx.fill();
  ctx.fillStyle = CHIP_TEXT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, left + CHIP_PAD_X, top + CHIP_HEIGHT / 2 + 0.5);
}

/** 正交折线 + 末端箭头：从热区右缘中点出发，先横后竖再横到目标页左上角。 */
function drawConnector(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color = LINE,
  width = 1.25,
): void {
  const gap = Math.max(18, Math.abs(to.x - from.x) / 2);
  const midX = to.x >= from.x ? from.x + gap : from.x - gap;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(midX, from.y);
  ctx.lineTo(midX, to.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  const dir = to.x >= midX ? 1 : -1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - ARROW * dir, to.y - ARROW * 0.7);
  ctx.lineTo(to.x - ARROW * dir, to.y + ARROW * 0.7);
  ctx.closePath();
  ctx.fill();
}

export function paintPrototypeLinks(ctx: CanvasRenderingContext2D, options: PrototypeLinkOptions): void {
  const { doc, vp } = options;
  const seen = new Set<NodeId>();
  for (const nodeId of options.nodeIds) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const node = doc.nodes[nodeId];
    if (!node) continue;
    const link = node.interactions?.find((item) => item.trigger === "click");
    if (!link) continue;
    const box = worldRect(doc, node.id);
    if (!box) continue;
    const from = worldToScreen(vp, box.x + box.width, box.y + box.height / 2);

    const target = link.targetId ? doc.nodes[link.targetId] : null;
    const targetBox = target?.type === "page" ? worldRect(doc, target.id) : null;
    const linked = Boolean(targetBox && targetVisible(vp, targetBox));
    const text =
      link.action === "back" || !target
        ? `← ${t("inspector.linkBack")}`
        : `→ ${target.name || t("node.page")}`;

    if (targetBox && linked) {
      const to = worldToScreen(vp, targetBox.x, targetBox.y);
      drawConnector(ctx, from, to);
      drawChip(ctx, to.x - chipWidth(ctx, text) / 2, to.y - CHIP_HEIGHT - 6, text, vp);
    } else {
      drawChip(ctx, from.x + 8, from.y - CHIP_HEIGHT / 2, text, vp);
    }
  }
}

export interface PrototypeFlowOptions {
  doc: DocState;
  vp: Viewport;
}

/**
 * 拖动模式的全量流向图：回答"这份稿子连起来没有"。
 * 只画两端都在视口内的连线（跨屏长线会把画布织成蜘蛛网），更淡更细，不画目标胶囊。
 */
export function paintPrototypeFlow(ctx: CanvasRenderingContext2D, options: PrototypeFlowOptions): void {
  const { doc, vp } = options;
  let drawn = 0;
  for (const pageId of doc.rootIds) {
    const page = doc.nodes[pageId];
    if (!page || page.type !== "page") continue;
    let full = false;
    walkSubtree(doc, page.id, (node) => {
      if (full) return;
      if (drawn >= FLOW_LIMIT) {
        full = true;
        return;
      }
      const link = node.interactions?.find((item) => item.action === "navigate" && item.targetId);
      if (!link?.targetId) return;
      const target = doc.nodes[link.targetId];
      if (!target || target.type !== "page") return;
      const from = worldRect(doc, node.id);
      const to = worldRect(doc, target.id);
      if (!from || !to) return;
      if (!targetVisible(vp, from) || !targetVisible(vp, to)) return;
      drawConnector(
        ctx,
        worldToScreen(vp, from.x + from.width, from.y + from.height / 2),
        worldToScreen(vp, to.x, to.y),
        FLOW_LINE,
        1,
      );
      drawn += 1;
    });
  }
}
