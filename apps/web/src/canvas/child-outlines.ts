/**
 * 悬停容器时描出一级子元素的边界（只读信息层）：
 * 指针下最深的画板/组件/实例算容器，页面不算。
 * 纯 UI 叠加层，不进入文档渲染 / 导出 / AI 截图。
 */
import { worldRect, type NodeId } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { docStore } from "../store";
import { pageAt } from "./hit";

const CONTAINER_TYPES = new Set(["frame", "component", "instance"]);

/** 指针下最深的容器（画板 / 组件 / 实例）；页面与普通节点不算。 */
export function hoverContainerAt(wx: number, wy: number): NodeId | null {
  const pageId = pageAt(wx, wy);
  if (!pageId) return null;
  let found: NodeId | null = null;
  const visit = (id: NodeId): void => {
    const parent = docStore.doc.nodes[id];
    if (!parent) return;
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const child = docStore.doc.nodes[parent.children[i]];
      if (!child || !child.visible) continue;
      if (!CONTAINER_TYPES.has(child.type)) continue;
      const r = worldRect(docStore.doc, child.id);
      if (r && wx >= r.x && wx <= r.x + r.width && wy >= r.y && wy <= r.y + r.height) {
        found = child.id;
        visit(child.id);
        return;
      }
    }
  };
  visit(pageId);
  return found;
}

/**
 * 画容器的可见一级子元素边界：1 屏幕像素中性灰虚线，无标签。
 * 容器开启裁剪时把描边裁到容器边界（溢出的部分本就看不见）。
 * 先铺一层白色发丝线做衬底，保证深色填充上也看得清。
 */
export function paintChildOutlines(g: CanvasRenderingContext2D, vp: Viewport, containerId: NodeId | null): void {
  if (!containerId) return;
  const container = docStore.doc.nodes[containerId];
  if (!container || container.children.length === 0) return;
  const bounds = worldRect(docStore.doc, containerId);

  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  for (const childId of container.children) {
    const child = docStore.doc.nodes[childId];
    if (!child || !child.visible) continue;
    const r = worldRect(docStore.doc, childId);
    if (!r) continue;
    const a = worldToScreen(vp, r.x, r.y);
    const b = worldToScreen(vp, r.x + r.width, r.y + r.height);
    boxes.push({
      x: Math.round(a.x) + 0.5,
      y: Math.round(a.y) + 0.5,
      w: Math.max(1, Math.round(b.x - a.x) - 1),
      h: Math.max(1, Math.round(b.y - a.y) - 1),
    });
  }
  if (boxes.length === 0) return;

  g.save();
  if (container.clip && bounds) {
    const a = worldToScreen(vp, bounds.x, bounds.y);
    const b = worldToScreen(vp, bounds.x + bounds.width, bounds.y + bounds.height);
    g.beginPath();
    g.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.clip();
  }
  // 衬底：白色细线，避免在深色填充上看不清
  g.strokeStyle = "rgba(255, 255, 255, 0.55)";
  g.lineWidth = 2;
  for (const box of boxes) g.strokeRect(box.x, box.y, box.w, box.h);
  // 中性灰虚线
  g.strokeStyle = "rgba(15, 23, 42, 0.5)";
  g.lineWidth = 1;
  g.setLineDash([4, 4]);
  for (const box of boxes) g.strokeRect(box.x, box.y, box.w, box.h);
  g.restore();
}
