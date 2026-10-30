/**
 * 视口导航：适配页面、切换活动页、飞行定位与脉冲标记。
 * 只改 UI 视口状态，不进文档、不进撤销。
 */
import { firstPageId, worldRect, type DocNode, type NodeId } from "@sqraft/core";
import { screenToWorld, type Viewport } from "@sqraft/render";
import { docStore, ui } from "../store";
import { pageAt } from "./hit";
import type { PenState } from "./pen";

export const PULSE_MS = 620;
export const FLY_MS = 420;

export interface ViewportNavDeps {
  vp: Viewport;
  pen: PenState;
  markDirty: () => void;
  commitEditors: () => void;
}

export function createViewportNav(deps: ViewportNavDeps) {
  const { vp, pen, markDirty } = deps;
  let didInitialFit = false;

  const nav = {
    pulse: null as { id: NodeId; start: number } | null,
    flight: null as { from: { x: number; y: number; zoom: number }; to: { x: number; y: number; zoom: number }; start: number } | null,
  };

  function flyTo(worldX: number, worldY: number, zoom: number): void {
    nav.flight = {
      from: { x: vp.x, y: vp.y, zoom: vp.zoom },
      to: { x: worldX - vp.width / (2 * zoom), y: worldY - vp.height / (2 * zoom), zoom },
      start: performance.now(),
    };
    markDirty();
  }

  function focusRect(id: NodeId, padding = 180): void {
    const r = worldRect(docStore.doc, id);
    if (!r) return;
    const zoom = Math.min(
      Math.max(Math.min((vp.width - padding) / r.width, (vp.height - padding) / r.height), 0.1),
      1,
    );
    flyTo(r.x + r.width / 2, r.y + r.height / 2, zoom);
    nav.pulse = { id, start: performance.now() };
  }

  function focusNode(id: NodeId): void {
    focusRect(id, 180);
  }

  function focusPage(id: NodeId): void {
    focusRect(id, 40);
  }

  function activePage(): DocNode | null {
    const id = ui.activePageId;
    const node = id ? docStore.doc.nodes[id] : null;
    return node && node.type === "page" ? node : null;
  }

  function pageAtViewportCenter(): DocNode | null {
    const w = screenToWorld(vp, vp.width / 2, vp.height / 2);
    const id = pageAt(w.x, w.y);
    return id ? docStore.doc.nodes[id] : null;
  }

  /** 保证编辑模式有一个活动页：记忆 → 视口中心 → 第一页。 */
  function ensureActivePage(): DocNode | null {
    const existing = activePage();
    if (existing) return existing;
    const center = pageAtViewportCenter();
    const fallbackId = firstPageId(docStore.doc);
    const fallback = fallbackId ? docStore.doc.nodes[fallbackId] : undefined;
    const page = center ?? fallback ?? null;
    if (page) ui.activePageId = page.id;
    return page;
  }

  function setActivePage(id: NodeId, focus = true): void {
    if (ui.activePageId !== id) {
      ui.activePageId = id;
      ui.selection = ui.selection.filter((sid) => docStore.doc.nodes[sid]?.parentId === id);
      pen.pathEdit = null;
      pen.vectorDrag = null;
      ui.instanceContext = [];
    }
    if (focus) focusPage(id);
    markDirty();
  }

  /** 适配全部页面（拖动模式 / 初始视图）。 */
  function fitAll(padding = 80): void {
    deps.commitEditors();
    const pages = docStore.doc.rootIds.map((id) => docStore.doc.nodes[id]).filter(Boolean);
    if (pages.length === 0) return;
    const minX = Math.min(...pages.map((p) => p.x));
    const minY = Math.min(...pages.map((p) => p.y));
    const maxX = Math.max(...pages.map((p) => p.x + p.width));
    const maxY = Math.max(...pages.map((p) => p.y + p.height));
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const zoom = Math.min(Math.max((vp.width - padding * 2) / w, 0.02), Math.max((vp.height - padding * 2) / h, 0.02), 1);
    vp.zoom = zoom;
    vp.x = minX + w / 2 - vp.width / (2 * zoom);
    vp.y = minY + h / 2 - vp.height / (2 * zoom);
    markDirty();
  }

  /** 适配活动页（编辑模式）。 */
  function fitActivePage(padding = 80): void {
    deps.commitEditors();
    const page = ensureActivePage();
    if (!page) return;
    const zoom = Math.min(
      Math.max((vp.width - padding * 2) / page.width, 0.02),
      Math.max((vp.height - padding * 2) / page.height, 0.02),
      1,
    );
    vp.zoom = zoom;
    vp.x = page.x + page.width / 2 - vp.width / (2 * zoom);
    vp.y = page.y + page.height / 2 - vp.height / (2 * zoom);
    markDirty();
  }

  /** 模式相关的"适配"：编辑模式 = 活动页，拖动模式 = 全部。 */
  function fitView(): void {
    if (ui.mode === "edit") fitActivePage();
    else fitAll();
  }

  /** 活动页在视口内的可见面积占比（0–1）。 */
  function visibleRatio(node: DocNode): number {
    const x1 = vp.x;
    const y1 = vp.y;
    const x2 = vp.x + vp.width / vp.zoom;
    const y2 = vp.y + vp.height / vp.zoom;
    const ix = Math.max(0, Math.min(node.x + node.width, x2) - Math.max(node.x, x1));
    const iy = Math.max(0, Math.min(node.y + node.height, y2) - Math.max(node.y, y1));
    return (ix * iy) / Math.max(1, node.width * node.height);
  }

  /** 视口尺寸跟随画布父容器；首次有尺寸时自动适配。 */
  function resize(canvasEl: HTMLCanvasElement | null): void {
    const el = canvasEl?.parentElement;
    if (!el) return;
    vp.width = el.clientWidth;
    vp.height = el.clientHeight;
    vp.dpr = window.devicePixelRatio || 1;
    if (!didInitialFit && vp.width > 0) {
      didInitialFit = true;
      fitView();
    }
    markDirty();
  }

  return {
    nav,
    resize,
    flyTo,
    focusRect,
    focusNode,
    focusPage,
    activePage,
    pageAtViewportCenter,
    ensureActivePage,
    setActivePage,
    fitAll,
    fitActivePage,
    fitView,
    visibleRatio,
  };
}
