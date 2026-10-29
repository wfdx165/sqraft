<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createNode, firstPageId, TEXT_LINE_HEIGHT, worldRect, type DocNode, type NodeId, type Rect } from "@sqraft/core";
import { Canvas2DBackend, drawDocument, screenToWorld, worldToScreen, type Viewport } from "@sqraft/render";
import { dispatch, docStore, hooks, select, switchMode, ui } from "../store";
import { DEFAULT_TEXT_FONT_FAMILY, DEFAULT_TEXT_FONT_SIZE, measureTextSize } from "../text-metrics";
import { keyOf, registerShortcuts } from "../shortcuts";
import { vTip } from "../tooltip";
import Icon from "./Icon.vue";

const canvasRef = ref<HTMLCanvasElement | null>(null);
const zoomPct = ref(100);
const zoomMenuOpen = ref(false);
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.5, 2, 4];
const vp: Viewport = { x: -200, y: -150, zoom: 1, width: 800, height: 600, dpr: window.devicePixelRatio || 1 };

/* 行内编辑浮层（DOM，覆盖在画布上；位置为屏幕坐标） */
const textEdit = ref<{
  id: NodeId;
  value: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  /** 打开时的缩放比例（编辑期间缩放会先提交并关闭） */
  scale: number;
} | null>(null);
const pageRename = ref<{ id: NodeId; value: string; left: number; top: number; width: number } | null>(null);
const textEditEl = ref<HTMLTextAreaElement | null>(null);
const renameEl = ref<HTMLInputElement | null>(null);
/** 悬停的文本节点（仅用于画淡虚线边界，不进文档） */
const hoverTextId = ref<NodeId | null>(null);

let ctx: CanvasRenderingContext2D | null = null;
let backend: Canvas2DBackend | null = null;
let raf = 0;
let dirty = true;
const PULSE_MS = 620;
const FLY_MS = 420;
let pulse: { id: NodeId; start: number } | null = null;
let flight: { from: { x: number; y: number; zoom: number }; to: { x: number; y: number; zoom: number }; start: number } | null = null;
let didInitialFit = false;

const TOOL_NAMES: Record<string, string> = { frame: "画板", rect: "矩形", ellipse: "椭圆", line: "直线", text: "文本" };

let drag: {
  pointerId: number;
  mode: "pan" | "create" | "move" | "resize";
  startX: number;
  startY: number;
  /** 指针按下时的屏幕坐标（用于 3px 拖拽阈值，双击不会把节点碰偏） */
  downX: number;
  downY: number;
  moved: boolean;
  startWX: number;
  startWY: number;
  offsetX: number;
  offsetY: number;
  pageId?: NodeId;
  /** 正在被拖动的页面矩形（仅页面参与参考线） */
  dragPages?: Rect[];
  /** 其它页面矩形（对齐/间距候选） */
  snapTargets?: Rect[];
  /** 缩放手柄与起始矩形 */
  handle?: ResizeHandle;
  resizeId?: NodeId;
  startRect?: Rect;
  startAspect?: number;
} | null = null;
let preview: { x: number; y: number; w: number; h: number; valid: boolean } | null = null;

type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};
const MIN_PAGE_SIZE = 200;
const MIN_NODE_SIZE = 8;
const HANDLE_HIT_PX = 7;
const ACTIVE_PAGE_ALPHA = 0.35;

/** 缩放中的实时预览（不改文档） */
let resizePreview: { id: NodeId; x: number; y: number; width: number; height: number } | null = null;
const hoverHandle = ref<ResizeHandle | null>(null);
const hoverInactive = ref(false);
const hoverLabel = ref(false);
const dragging = ref(false);

/* 页面参考线（世界坐标，拖拽中计算，绘制时转屏幕） */
const SNAP_PX = 6;
const GUIDE_COLOR = "rgba(244, 63, 142, 0.95)";
const GUIDE_TEXT_COLOR = "#c9166b";
interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
interface GapMark {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  value: number;
}
let guideLines: GuideLine[] = [];
let gapMarks: GapMark[] = [];

const cursor = computed(() => {
  if (ui.mode === "pan") return dragging.value ? "grabbing" : "grab";
  if (ui.tool !== "select") return "crosshair";
  if (hoverHandle.value) return HANDLE_CURSORS[hoverHandle.value];
  if (hoverLabel.value) return "move";
  if (hoverTextId.value) return "text";
  if (hoverInactive.value) return "pointer";
  return "default";
});

function markDirty() {
  dirty = true;
}

/** 随缩放自适应的点阵背景（屏幕空间绘制）。 */
function drawGrid(g: CanvasRenderingContext2D, v: Viewport) {
  let world = 24;
  while (world * v.zoom < 14) world *= 2;
  const step = world * v.zoom;
  const offX = -((v.x * v.zoom) % step + step) % step;
  const offY = -((v.y * v.zoom) % step + step) % step;
  g.save();
  g.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  g.fillStyle = "rgba(15, 23, 42, 0.10)";
  for (let x = offX; x < v.width; x += step) {
    for (let y = offY; y < v.height; y += step) {
      g.fillRect(x, y, 1.3, 1.3);
    }
  }
  g.restore();
}

const LABEL_FONT = "11px 'Geist Variable', 'PingFang SC', sans-serif";

function drawPageLabels(g: CanvasRenderingContext2D) {
  g.save();
  g.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  g.font = LABEL_FONT;
  g.textBaseline = "alphabetic";
  for (const pageId of docStore.doc.rootIds) {
    const page = docStore.doc.nodes[pageId];
    if (!page) continue;
    // 改名浮层打开时不再画标签，避免重影
    if (pageRename.value?.id === page.id) continue;
    const moving = drag && drag.mode === "move" && drag.moved && ui.selection.includes(page.id);
    const rp = resizePreview && resizePreview.id === page.id ? resizePreview : null;
    const a = worldToScreen(
      vp,
      (rp ? rp.x : page.x) + (moving ? drag!.offsetX : 0),
      (rp ? rp.y : page.y) + (moving ? drag!.offsetY : 0),
    );
    if (a.x > vp.width || a.y > vp.height + 20) continue;
    const label = page.name;
    const tw = g.measureText(label).width;
    g.globalAlpha = ui.mode === "edit" && ui.activePageId !== page.id ? ACTIVE_PAGE_ALPHA : 1;
    g.fillStyle = "rgba(255,255,255,0.72)";
    g.beginPath();
    (g as unknown as { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(a.x - 6, a.y - 24, tw + 12, 18, 6);
    g.fill();
    g.fillStyle = "rgba(23, 23, 28, 0.62)";
    g.fillText(label, a.x, a.y - 11);
    g.globalAlpha = 1;
  }
  g.restore();
}

/** 页面名称标签的屏幕矩形（与 drawPageLabels 保持一致）。 */
function pageLabelRect(page: DocNode): { x: number; y: number; width: number; height: number } {
  const a = worldToScreen(vp, page.x, page.y);
  let tw = page.name.length * 11;
  if (ctx) {
    ctx.save();
    ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
    ctx.font = LABEL_FONT;
    tw = ctx.measureText(page.name).width;
    ctx.restore();
  }
  return { x: a.x - 6, y: a.y - 24, width: tw + 12, height: 18 };
}

function labelAt(sx: number, sy: number): DocNode | null {
  for (const pageId of docStore.doc.rootIds) {
    const page = docStore.doc.nodes[pageId];
    if (!page) continue;
    const r = pageLabelRect(page);
    if (sx >= r.x && sx <= r.x + r.width && sy >= r.y && sy <= r.y + r.height) return page;
  }
  return null;
}

/** 页面参考线与间距标注（屏幕空间固定像素粗细/字号）。 */
function drawGuides(g: CanvasRenderingContext2D) {
  if (guideLines.length === 0 && gapMarks.length === 0) return;
  g.save();
  g.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);

  g.strokeStyle = GUIDE_COLOR;
  g.lineWidth = 1;
  for (const line of guideLines) {
    const a = worldToScreen(vp, line.x1, line.y1);
    const b = worldToScreen(vp, line.x2, line.y2);
    g.beginPath();
    g.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
    g.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
    g.stroke();
  }

  g.font = "10px 'Geist Mono Variable', ui-monospace, monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const mark of gapMarks) {
    const a = worldToScreen(vp, mark.x1, mark.y1);
    const b = worldToScreen(vp, mark.x2, mark.y2);
    const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    // 两端短刻线
    if (horizontal) {
      g.moveTo(a.x, a.y - 4);
      g.lineTo(a.x, a.y + 4);
      g.moveTo(b.x, b.y - 4);
      g.lineTo(b.x, b.y + 4);
    } else {
      g.moveTo(a.x - 4, a.y);
      g.lineTo(a.x + 4, a.y);
      g.moveTo(b.x - 4, b.y);
      g.lineTo(b.x + 4, b.y);
    }
    g.stroke();

    const label = String(mark.value);
    const w = g.measureText(label).width + 10;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    g.fillStyle = "rgba(255, 255, 255, 0.96)";
    g.beginPath();
    (g as unknown as { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(cx - w / 2, cy - 8, w, 16, 4);
    g.fill();
    g.fillStyle = GUIDE_TEXT_COLOR;
    g.fillText(label, cx, cy + 0.5);
  }

  g.restore();
}

function handlePoints(r: { x: number; y: number; width: number; height: number }): [ResizeHandle, number, number][] {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const x2 = r.x + r.width;
  const y2 = r.y + r.height;
  return [
    ["nw", r.x, r.y],
    ["n", cx, r.y],
    ["ne", x2, r.y],
    ["e", x2, cy],
    ["se", x2, y2],
    ["s", cx, y2],
    ["sw", r.x, y2],
    ["w", r.x, cy],
  ];
}

/** 当前选中对象在屏幕上的矩形（含移动/缩放预览）。 */
function selectionScreenRect(id: NodeId): { x: number; y: number; width: number; height: number } | null {
  const r = worldRect(docStore.doc, id);
  if (!r) return null;
  if (resizePreview && resizePreview.id === id) {
    const a = worldToScreen(vp, resizePreview.x, resizePreview.y);
    const b = worldToScreen(vp, resizePreview.x + resizePreview.width, resizePreview.y + resizePreview.height);
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  }
  const dx = drag && drag.mode === "move" && drag.moved ? drag.offsetX : 0;
  const dy = drag && drag.mode === "move" && drag.moved ? drag.offsetY : 0;
  const a = worldToScreen(vp, r.x + dx, r.y + dy);
  const b = worldToScreen(vp, r.x + dx + r.width, r.y + dy + r.height);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

function draw() {
  if (!ctx || !backend) return;

  zoomPct.value = Math.round(vp.zoom * 100);
  const editing = ui.mode === "edit";

  // 拖动中的实时预览：只偏移"移动根"（父节点也被选中的子节点不重复偏移）
  const movePreview =
    editing && drag && drag.mode === "move" && drag.moved
      ? {
          ids: ui.selection.filter((id) => {
            const n = docStore.doc.nodes[id];
            return Boolean(n) && (!n!.parentId || !ui.selection.includes(n!.parentId));
          }),
          dx: drag.offsetX,
          dy: drag.offsetY,
        }
      : undefined;

  // 非活动页淡化（编辑模式）
  const dimPageIds = editing ? docStore.doc.rootIds.filter((id) => id !== ui.activePageId) : undefined;

  backend.beginFrame(vp);
  drawGrid(ctx, vp);
  drawDocument(backend, docStore.doc, {
    hideTextId: textEdit.value?.id,
    movePreview,
    resizePreview: editing ? (resizePreview ?? undefined) : undefined,
    dimPageIds,
  });
  backend.endFrame();

  // 覆盖层：选中框 / 手柄 / 尺寸徽标 / 拖拽预览 / 脉冲
  ctx.save();
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);

  for (const id of ui.selection) {
    const n = docStore.doc.nodes[id];
    if (!n) continue;
    // 行内编辑中的文本只用输入框表示边界
    if (textEdit.value?.id === id) continue;
    const rect = selectionScreenRect(id);
    if (!rect) continue;
    const { x, y, width, height } = rect;

    ctx.strokeStyle = "#4f46e5";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, width, height);

    if (editing && ui.selection.length === 1 && n.type !== "text") {
      for (const [, hx, hy] of handlePoints(rect)) {
        ctx.beginPath();
        ctx.rect(hx - 3, hy - 3, 6, 6);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = "#4f46e5";
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
    }

    if (ui.selection.length === 1) {
      const label = `${Math.round(resizePreview && resizePreview.id === id ? resizePreview.width : n.width)} × ${
        Math.round(resizePreview && resizePreview.id === id ? resizePreview.height : n.height)
      }`;
      ctx.font = "10.5px 'Geist Mono Variable', ui-monospace, monospace";
      const tw = ctx.measureText(label).width;
      const bw = tw + 14;
      const bh = 19;
      const bx = x + width / 2 - bw / 2;
      const by = y - bh - 8;
      ctx.beginPath();
      (ctx as unknown as { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(bx, by, bw, bh, 5);
      ctx.fillStyle = "#4f46e5";
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, bx + bw / 2, by + bh / 2 + 0.5);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
  }

  // 悬停文本：淡紫虚线边界（选中时由上面的实线框接管）
  if (
    editing &&
    hoverTextId.value &&
    !ui.selection.includes(hoverTextId.value) &&
    !textEdit.value
  ) {
    const r = worldRect(docStore.doc, hoverTextId.value);
    if (r) {
      const a = worldToScreen(vp, r.x, r.y);
      const b = worldToScreen(vp, r.x + r.width, r.y + r.height);
      ctx.save();
      ctx.strokeStyle = "rgba(79, 70, 229, 0.45)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
      ctx.restore();
    }
  }

  drawGuides(ctx);

  if (preview) {
    const a = worldToScreen(vp, Math.min(preview.x, preview.x + preview.w), Math.min(preview.y, preview.y + preview.h));
    const b = worldToScreen(vp, Math.max(preview.x, preview.x + preview.w), Math.max(preview.y, preview.y + preview.h));
    ctx.fillStyle = preview.valid ? "rgba(79, 70, 229, 0.08)" : "rgba(214, 69, 69, 0.08)";
    ctx.strokeStyle = preview.valid ? "rgba(79, 70, 229, 0.65)" : "rgba(214, 69, 69, 0.75)";
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 4]);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
  }

  if (pulse) {
    const n = docStore.doc.nodes[pulse.id];
    const t = (performance.now() - pulse.start) / PULSE_MS;
    if (!n || t >= 1) {
      pulse = null;
    } else {
      const r = worldRect(docStore.doc, pulse.id);
      if (r) {
        const a = worldToScreen(vp, r.x, r.y);
        const b = worldToScreen(vp, r.x + r.width, r.y + r.height);
        const ease = 1 - (1 - t) * (1 - t);
        ctx.strokeStyle = `rgba(79, 70, 229, ${(1 - t) * 0.95})`;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = "rgba(79, 70, 229, 0.6)";
        ctx.shadowBlur = 18 * (1 - t);
        const grow = ease * 6;
        ctx.strokeRect(a.x - grow, a.y - grow, b.x - a.x + grow * 2, b.y - a.y + grow * 2);
        ctx.shadowBlur = 0;
      }
    }
  }

  ctx.restore();
  drawPageLabels(ctx);
}

function loop() {
  const now = performance.now();
  if (flight) {
    const t = Math.min(1, (now - flight.start) / FLY_MS);
    const e = 1 - Math.pow(1 - t, 3);
    vp.x = flight.from.x + (flight.to.x - flight.from.x) * e;
    vp.y = flight.from.y + (flight.to.y - flight.from.y) * e;
    vp.zoom = flight.from.zoom + (flight.to.zoom - flight.from.zoom) * e;
    if (t >= 1) flight = null;
    dirty = true;
  }
  if (dirty || (pulse && now - pulse.start < PULSE_MS)) {
    dirty = false;
    draw();
  }
  raf = requestAnimationFrame(loop);
}

function resize() {
  const el = canvasRef.value?.parentElement;
  if (el) {
    vp.width = el.clientWidth;
    vp.height = el.clientHeight;
    vp.dpr = window.devicePixelRatio || 1;
    if (!didInitialFit && vp.width > 0) {
      didInitialFit = true;
      fitView();
    }
    markDirty();
  }
}

/** 适配全部页面（拖动模式 / 初始视图）。 */
function fitAll(padding = 80) {
  commitEditors();
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
function fitActivePage(padding = 80) {
  commitEditors();
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
function fitView() {
  if (ui.mode === "edit") fitActivePage();
  else fitAll();
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
  const fallback = docStore.doc.nodes[firstPageId(docStore.doc)];
  const page = center ?? fallback ?? null;
  if (page) ui.activePageId = page.id;
  return page;
}

/** 切换活动页；清掉旧页选区，可选飞行适配。 */
function setActivePage(id: NodeId, focus = true) {
  if (ui.activePageId !== id) {
    ui.activePageId = id;
    ui.selection = ui.selection.filter((sid) => docStore.doc.nodes[sid]?.parentId === id);
  }
  if (focus) focusPage(id);
  markDirty();
}

function flyTo(worldX: number, worldY: number, zoom: number) {
  flight = {
    from: { x: vp.x, y: vp.y, zoom: vp.zoom },
    to: { x: worldX - vp.width / (2 * zoom), y: worldY - vp.height / (2 * zoom), zoom },
    start: performance.now(),
  };
  markDirty();
}

/** 图层/页面定位：居中飞行 + 脉冲标记。 */
function focusRect(id: NodeId, padding = 180) {
  const r = worldRect(docStore.doc, id);
  if (!r) return;
  const zoom = Math.min(
    Math.max(Math.min((vp.width - padding) / r.width, (vp.height - padding) / r.height), 0.1),
    1,
  );
  flyTo(r.x + r.width / 2, r.y + r.height / 2, zoom);
  pulse = { id, start: performance.now() };
}

function focusNode(id: NodeId) {
  focusRect(id, 180);
}

function focusPage(id: NodeId) {
  focusRect(id, 40);
}

/* ---------- 命中检测（累加容器偏移） ---------- */

function hitIn(nodeId: NodeId, lx: number, ly: number): NodeId | null {
  const node = docStore.doc.nodes[nodeId];
  if (!node) return null;
  for (let i = node.children.length - 1; i >= 0; i--) {
    const c = docStore.doc.nodes[node.children[i]];
    if (!c || !c.visible) continue;
    if (lx >= c.x && lx <= c.x + c.width && ly >= c.y && ly <= c.y + c.height) {
      return hitIn(c.id, lx - c.x, ly - c.y) ?? c.id;
    }
  }
  return null;
}

interface Hit {
  id: NodeId;
  pageId: NodeId;
  /** 命中非活动页（编辑模式下只切换活动页，不选子节点） */
  inactive: boolean;
}

function hitTest(wx: number, wy: number): Hit | null {
  const editing = ui.mode === "edit";
  for (const pageId of docStore.doc.rootIds) {
    const page = docStore.doc.nodes[pageId];
    if (!page) continue;
    if (wx < page.x || wy < page.y || wx > page.x + page.width || wy > page.y + page.height) continue;
    if (editing && pageId !== ui.activePageId) return { id: pageId, pageId, inactive: true };
    const deep = hitIn(pageId, wx - page.x, wy - page.y);
    return { id: deep ?? pageId, pageId, inactive: false };
  }
  return null;
}

function hitHandle(sx: number, sy: number): { handle: ResizeHandle; id: NodeId } | null {
  if (ui.mode !== "edit" || ui.tool !== "select" || ui.selection.length !== 1) return null;
  const id = ui.selection[0];
  const node = docStore.doc.nodes[id];
  if (!node || node.type === "text") return null;
  const rect = selectionScreenRect(id);
  if (!rect) return null;
  for (const [handle, hx, hy] of handlePoints(rect)) {
    if (Math.abs(sx - hx) <= HANDLE_HIT_PX && Math.abs(sy - hy) <= HANDLE_HIT_PX) return { handle, id };
  }
  return null;
}

function pageAt(wx: number, wy: number): NodeId | null {
  for (const pageId of docStore.doc.rootIds) {
    const page = docStore.doc.nodes[pageId];
    if (page && wx >= page.x && wx <= page.x + page.width && wy >= page.y && wy <= page.y + page.height) return pageId;
  }
  return null;
}

function unionRects(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 页面间参考线：边/中线吸附 + 与最近页面的间距标注。
 * 只修正拖动偏移（拖动中的视觉），提交时仍是一条 node.update 命令。
 */
function computePageGuides(dragRects: Rect[], targets: Rect[]) {
  guideLines = [];
  gapMarks = [];
  const d = drag;
  if (!d || targets.length === 0 || dragRects.length === 0) return;
  const threshold = SNAP_PX / vp.zoom;
  const moved = unionRects(dragRects.map((r) => ({ ...r, x: r.x + d.offsetX, y: r.y + d.offsetY })));
  const movedXs = [moved.x, moved.x + moved.width / 2, moved.x + moved.width];
  const movedYs = [moved.y, moved.y + moved.height / 2, moved.y + moved.height];

  let bestX: { delta: number; at: number; target: Rect } | null = null;
  let bestY: { delta: number; at: number; target: Rect } | null = null;
  for (const t of targets) {
    for (const ax of [t.x, t.x + t.width / 2, t.x + t.width]) {
      for (const mx of movedXs) {
        const delta = ax - mx;
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, at: ax, target: t };
      }
    }
    for (const ay of [t.y, t.y + t.height / 2, t.y + t.height]) {
      for (const my of movedYs) {
        const delta = ay - my;
        if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, at: ay, target: t };
      }
    }
  }

  if (bestX) {
    d.offsetX += bestX.delta;
    guideLines.push({
      x1: bestX.at,
      y1: Math.min(moved.y, bestX.target.y),
      x2: bestX.at,
      y2: Math.max(moved.y + moved.height, bestX.target.y + bestX.target.height),
    });
  }
  if (bestY) {
    d.offsetY += bestY.delta;
    guideLines.push({
      x1: Math.min(moved.x, bestY.target.x),
      y1: bestY.at,
      x2: Math.max(moved.x + moved.width, bestY.target.x + bestY.target.width),
      y2: bestY.at,
    });
  }

  const box = unionRects(dragRects.map((r) => ({ ...r, x: r.x + d.offsetX, y: r.y + d.offsetY })));
  let bestH: { gap: number; a: number; b: number; y: number } | null = null;
  let bestV: { gap: number; a: number; b: number; x: number } | null = null;
  for (const t of targets) {
    // 水平间距：两页在纵向有投影重叠
    const oyTop = Math.max(box.y, t.y);
    const oyBottom = Math.min(box.y + box.height, t.y + t.height);
    if (oyBottom - oyTop > 1) {
      const y = (oyTop + oyBottom) / 2;
      const gapRight = t.x - (box.x + box.width);
      const gapLeft = box.x - (t.x + t.width);
      if (gapRight > 0.5 && (!bestH || gapRight < bestH.gap)) bestH = { gap: gapRight, a: box.x + box.width, b: t.x, y };
      if (gapLeft > 0.5 && (!bestH || gapLeft < bestH.gap)) bestH = { gap: gapLeft, a: box.x, b: t.x + t.width, y };
    }
    // 垂直间距：两页在横向有投影重叠
    const oxLeft = Math.max(box.x, t.x);
    const oxRight = Math.min(box.x + box.width, t.x + t.width);
    if (oxRight - oxLeft > 1) {
      const x = (oxLeft + oxRight) / 2;
      const gapBelow = t.y - (box.y + box.height);
      const gapAbove = box.y - (t.y + t.height);
      if (gapBelow > 0.5 && (!bestV || gapBelow < bestV.gap)) bestV = { gap: gapBelow, a: box.y + box.height, b: t.y, x };
      if (gapAbove > 0.5 && (!bestV || gapAbove < bestV.gap)) bestV = { gap: gapAbove, a: box.y, b: t.y + t.height, x };
    }
  }
  if (bestH) gapMarks.push({ x1: bestH.a, y1: bestH.y, x2: bestH.b, y2: bestH.y, value: Math.round(bestH.gap) });
  if (bestV) gapMarks.push({ x1: bestV.x, y1: bestV.a, x2: bestV.x, y2: bestV.b, value: Math.round(bestV.gap) });
}

/* ---------- 行内编辑（页面名 / 文本节点） ---------- */

function commitEditors() {
  if (textEdit.value) commitTextEdit();
  if (pageRename.value) commitPageRename();
}

function startPageRename(page: DocNode) {
  const r = pageLabelRect(page);
  pageRename.value = { id: page.id, value: page.name, left: r.x, top: r.y, width: Math.max(r.width, 96) };
  markDirty();
  void nextTick(() => {
    renameEl.value?.focus();
    renameEl.value?.select();
  });
}

function commitPageRename() {
  const ed = pageRename.value;
  pageRename.value = null;
  if (!ed) return;
  const page = docStore.doc.nodes[ed.id];
  const name = ed.value.replace(/\s+/g, " ").trim();
  if (page && name && name !== page.name) {
    dispatch({ type: "node.update", params: { nodeId: ed.id, patch: { name } } }, "rename-page");
  }
  markDirty();
}

function cancelPageRename() {
  pageRename.value = null;
  markDirty();
}

function onRenameKey(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (e.key === "Enter") {
    e.preventDefault();
    commitPageRename();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelPageRename();
  }
}

function syncTextEditSize() {
  const ed = textEdit.value;
  if (!ed) return;
  const size = measureTextSize(ed.value, ed.fontSize, ed.fontFamily, ed.fontWeight);
  ed.width = Math.max(size.width * ed.scale + 6, 24);
  ed.height = Math.max(size.height * ed.scale, ed.fontSize * ed.scale * TEXT_LINE_HEIGHT);
}

function startTextEdit(node: DocNode, selectAll = false) {
  const r = worldRect(docStore.doc, node.id);
  if (!r) return;
  const a = worldToScreen(vp, r.x, r.y);
  const fontSize = node.style.fontSize ?? DEFAULT_TEXT_FONT_SIZE;
  const fontFamily = node.style.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY;
  const fontWeight = node.style.fontWeight ?? 400;
  const scale = vp.zoom;
  const size = measureTextSize(node.text ?? "文本", fontSize, fontFamily, fontWeight);
  // DOM 行盒有半行距，向上补偿使输入文字与画布文字位置一致
  const halfLeading = ((TEXT_LINE_HEIGHT - 1) * fontSize * scale) / 2;
  textEdit.value = {
    id: node.id,
    value: node.text ?? "",
    left: a.x,
    top: a.y - halfLeading,
    width: Math.max(size.width * scale + 6, 24),
    height: Math.max(size.height * scale, fontSize * scale * TEXT_LINE_HEIGHT),
    fontSize,
    fontFamily,
    fontWeight,
    scale,
  };
  select([node.id]);
  markDirty();
  void nextTick(() => {
    const el = textEditEl.value;
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
    syncTextEditSize();
  });
}

function commitTextEdit() {
  const ed = textEdit.value;
  textEdit.value = null;
  if (!ed) return;
  const node = docStore.doc.nodes[ed.id];
  if (!node) {
    markDirty();
    return;
  }
  const text = ed.value.replace(/\r\n/g, "\n");
  if (!text.trim()) {
    dispatch({ type: "node.delete", params: { nodeId: ed.id } }, "edit-text");
    select(ui.selection.filter((id) => id !== ed.id));
    markDirty();
    return;
  }
  if (text === (node.text ?? "")) {
    markDirty();
    return;
  }
  const size = measureTextSize(text, ed.fontSize, ed.fontFamily, ed.fontWeight);
  dispatch(
    { type: "node.update", params: { nodeId: ed.id, patch: { text, width: size.width, height: size.height } } },
    "edit-text",
  );
  markDirty();
}

function cancelTextEdit() {
  textEdit.value = null;
  markDirty();
}

function onTextEditKey(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    commitTextEdit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelTextEdit();
  }
}

function onDoubleClick(e: MouseEvent) {
  // 拖动模式只浏览：单击/双击都不改选区、不进编辑
  if (ui.mode === "pan") return;
  const rect = canvasRef.value!.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const label = labelAt(sx, sy);
  if (label) {
    if (label.id !== ui.activePageId) setActivePage(label.id, false);
    startPageRename(label);
    return;
  }
  const w = screenToWorld(vp, sx, sy);
  const hit = hitTest(w.x, w.y);
  if (!hit) {
    select([]);
    return;
  }
  if (hit.inactive) {
    setActivePage(hit.pageId, false);
    select([hit.pageId]);
    return;
  }
  const node = docStore.doc.nodes[hit.id];
  if (!node) return;
  if (node.type === "text") {
    startTextEdit(node);
    return;
  }
  // 其它组件：双击 = 选中 + 检查器同步 + 左栏展开所在页面
  select([hit.id]);
  ui.expandedPageId = hit.pageId;
  markDirty();
}

/* 指针交互见下方 onPointerDown（含模式 / 手柄 / 活动页） */

function setHoverText(id: NodeId | null) {
  if (hoverTextId.value === id) return;
  hoverTextId.value = id;
  markDirty();
}

function clearHover() {
  setHoverText(null);
  if (hoverHandle.value) {
    hoverHandle.value = null;
    markDirty();
  }
  if (hoverInactive.value) {
    hoverInactive.value = false;
    markDirty();
  }
  if (hoverLabel.value) {
    hoverLabel.value = false;
    markDirty();
  }
}

function updateHover(e: PointerEvent) {
  if (!canvasRef.value || ui.mode === "pan" || ui.tool !== "select") {
    clearHover();
    return;
  }
  const rect = canvasRef.value.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const handle = hitHandle(sx, sy)?.handle ?? null;
  if (hoverHandle.value !== handle) {
    hoverHandle.value = handle;
    markDirty();
  }
  const w = screenToWorld(vp, sx, sy);
  const hit = hitTest(w.x, w.y);
  const node = hit && !hit.inactive ? docStore.doc.nodes[hit.id] : null;
  setHoverText(node?.type === "text" ? node.id : null);
  // 页面名称标签是编辑模式下移动整页的唯一入口，用 move 光标提示可拖
  const onLabel = Boolean(labelAt(sx, sy));
  if (hoverLabel.value !== onLabel) {
    hoverLabel.value = onLabel;
    markDirty();
  }
  const inactive = Boolean(hit?.inactive);
  if (hoverInactive.value !== inactive) {
    hoverInactive.value = inactive;
    markDirty();
  }
}

function onPointerLeave() {
  if (!drag) clearHover();
}

/** 根据手柄与指针位移计算新矩形（世界坐标；`keepAspect` 对应 Shift）。 */
function resizeRect(start: Rect, handle: ResizeHandle, dx: number, dy: number, keepAspect: boolean, min: number): Rect {
  let x = start.x;
  let y = start.y;
  let width = start.width;
  let height = start.height;
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  if (handle.includes("e")) width = start.width + dx;
  if (handle.includes("s")) height = start.height + dy;
  if (handle.includes("w")) {
    x = start.x + dx;
    width = start.width - dx;
  }
  if (handle.includes("n")) {
    y = start.y + dy;
    height = start.height - dy;
  }

  const corner = handle.length === 2;
  if (corner && keepAspect) {
    const aspect = start.width / Math.max(1, start.height);
    if (Math.abs(width - start.width) >= Math.abs(height - start.height)) height = width / aspect;
    else width = height * aspect;
    if (handle.includes("w")) x = right - width;
    if (handle.includes("n")) y = bottom - height;
  }

  if (width < min) {
    width = min;
    if (handle.includes("w")) x = right - min;
  }
  if (height < min) {
    height = min;
    if (handle.includes("n")) y = bottom - min;
  }
  return { x, y, width, height };
}

function onPointerDown(e: PointerEvent) {
  commitEditors();
  clearHover();
  const rect = canvasRef.value!.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const w = screenToWorld(vp, sx, sy);
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  const base = {
    pointerId: e.pointerId,
    startX: sx,
    startY: sy,
    downX: sx,
    downY: sy,
    moved: false,
    startWX: vp.x,
    startWY: vp.y,
    offsetX: 0,
    offsetY: 0,
  };

  // 拖动模式：任意处拖动都是平移（包括页面与图层上方）
  if (ui.mode === "pan") {
    if (e.button !== 0 && e.button !== 1) return;
    drag = { ...base, mode: "pan" };
    dragging.value = true;
    return;
  }

  // 编辑模式：中键不再平移（视图操作属于拖动模式）
  if (e.button === 1) return;

  // 1) 缩放手柄（仅单选、非文本）
  const handleHit = hitHandle(sx, sy);
  if (handleHit) {
    const node = docStore.doc.nodes[handleHit.id];
    if (node) {
      const startRect = { x: node.x, y: node.y, width: node.width, height: node.height };
      resizePreview = { id: node.id, ...startRect };
      drag = {
        ...base,
        startX: w.x,
        startY: w.y,
        mode: "resize",
        handle: handleHit.handle,
        resizeId: node.id,
        startRect,
      };
      dragging.value = true;
      return;
    }
  }

  // 2) 页面名称标签：选中并开始移动整页——这是页面唯一的拖动入口
  const label = labelAt(sx, sy);
  if (label) {
    if (label.id !== ui.activePageId) setActivePage(label.id, false);
    select([label.id]);
    ui.expandedPageId = label.id;
    drag = { ...base, startX: w.x, startY: w.y, mode: "move", ...pageDragContext([label.id]) };
    markDirty();
    return;
  }

  // 3) 绘图工具：只允许在页面内起笔；落在非活动页先切换活动页
  if (ui.tool !== "select") {
    const pageId = pageAt(w.x, w.y);
    if (!pageId) return;
    if (pageId !== ui.activePageId) setActivePage(pageId, false);
    drag = { ...base, startX: w.x, startY: w.y, mode: "create", pageId };
    preview = { x: w.x, y: w.y, w: 0, h: 0, valid: true };
    return;
  }

  // 4) 选择
  const hit = hitTest(w.x, w.y);
  if (!hit) {
    select([]);
    return;
  }
  if (hit.inactive) {
    // 先切换活动页，再选中该页（不顺势拖动，避免误移整页）
    setActivePage(hit.pageId, false);
    select([hit.pageId]);
    ui.expandedPageId = hit.pageId;
    markDirty();
    return;
  }
  if (e.shiftKey) {
    const set = new Set(ui.selection);
    if (set.has(hit.id)) set.delete(hit.id);
    else set.add(hit.id);
    select([...set]);
  } else if (!ui.selection.includes(hit.id)) {
    select([hit.id]);
  }

  // 页面只能通过名称标签移动：在页面空白处拖动不做任何事（不平移、不移动整页）
  if (docStore.doc.nodes[hit.id]?.type === "page") {
    ui.expandedPageId = hit.pageId;
    markDirty();
    return;
  }
  // 页面间参考线只对页面生效（普通图层拖动时通常为空）
  const { dragPages, snapTargets } = pageDragContext(ui.selection);
  drag = { ...base, startX: w.x, startY: w.y, mode: "move", dragPages, snapTargets };
}

/** 拖动页面的参考线上下文：只有页面参与边/中线对齐与间距标注。 */
function pageDragContext(selection: readonly NodeId[]): { dragPages: Rect[]; snapTargets: Rect[] } {
  const dragPages = selection
    .map((id) => docStore.doc.nodes[id])
    .filter((n): n is DocNode => Boolean(n) && n!.type === "page")
    .map((n) => worldRect(docStore.doc, n.id))
    .filter((r): r is Rect => Boolean(r));
  const snapTargets =
    dragPages.length === 0
      ? []
      : docStore.doc.rootIds
          .filter((pid) => !selection.includes(pid))
          .map((pid) => docStore.doc.nodes[pid])
          .filter((p): p is DocNode => Boolean(p) && p!.type === "page")
          .map((p) => worldRect(docStore.doc, p.id))
          .filter((r): r is Rect => Boolean(r));
  return { dragPages, snapTargets };
}

function onPointerMove(e: PointerEvent) {
  if (!drag) {
    updateHover(e);
    return;
  }
  if (e.pointerId !== drag.pointerId || e.buttons === 0) return;
  const rect = canvasRef.value!.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const w = screenToWorld(vp, sx, sy);
  if (drag.mode === "pan") {
    vp.x = drag.startWX - (sx - drag.startX) / vp.zoom;
    vp.y = drag.startWY - (sy - drag.startY) / vp.zoom;
  } else if (ui.mode !== "edit") {
    // 非编辑模式一律不允许移动/缩放/绘制（防御：模式在拖动中被切换时不留下残留手势）
    drag = null;
    resizePreview = null;
    preview = null;
    guideLines = [];
    gapMarks = [];
    dragging.value = false;
    return;
  } else if (drag.mode === "move") {
    // 3px 阈值：双击/手抖不产生移动命令
    if (!drag.moved) {
      if (Math.hypot(sx - drag.downX, sy - drag.downY) < 3) return;
      drag.moved = true;
    }
    drag.offsetX = w.x - drag.startX;
    drag.offsetY = w.y - drag.startY;
    if (drag.dragPages?.length) computePageGuides(drag.dragPages, drag.snapTargets ?? []);
  } else if (drag.mode === "resize") {
    if (!drag.resizeId || !drag.startRect || !drag.handle) return;
    if (!drag.moved) {
      if (Math.hypot(sx - drag.downX, sy - drag.downY) < 2) return;
      drag.moved = true;
    }
    const node = docStore.doc.nodes[drag.resizeId];
    const min = node?.type === "page" ? MIN_PAGE_SIZE : MIN_NODE_SIZE;
    const next = resizeRect(drag.startRect, drag.handle, w.x - drag.startX, w.y - drag.startY, e.shiftKey, min);
    resizePreview = { id: drag.resizeId, ...next };
  } else if (drag.mode === "create" && preview) {
    preview = { x: drag.startX, y: drag.startY, w: w.x - drag.startX, h: w.y - drag.startY, valid: Boolean(drag.pageId) };
  }
  markDirty();
}

function onPointerUp() {
  if (!drag) return;
  dragging.value = false;
  // 只有编辑模式才提交移动/缩放；模式被切换过就整段丢弃（不产生命令、不留预览）
  if (drag.mode !== "pan" && ui.mode !== "edit") {
    resizePreview = null;
    preview = null;
    drag = null;
    guideLines = [];
    gapMarks = [];
    markDirty();
    return;
  }
  if (drag.mode === "resize") {
    if (drag.moved && resizePreview) {
      const node = docStore.doc.nodes[resizePreview.id];
      if (node) {
        const next = {
          x: Math.round(resizePreview.x),
          y: Math.round(resizePreview.y),
          width: Math.round(resizePreview.width),
          height: Math.round(resizePreview.height),
        };
        if (next.x !== node.x || next.y !== node.y || next.width !== node.width || next.height !== node.height) {
          dispatch({ type: "node.update", params: { nodeId: node.id, patch: next } }, "resize");
        }
      }
    }
    resizePreview = null;
    drag = null;
    markDirty();
    return;
  }
  if (drag.mode === "move" && drag.moved && (drag.offsetX || drag.offsetY)) {
    const ids = [...ui.selection];
    const cmds = ids
      .filter((id) => docStore.doc.nodes[id])
      .map((id) => {
        const n = docStore.doc.nodes[id];
        return { type: "node.update" as const, params: { nodeId: id, patch: { x: n.x + drag!.offsetX, y: n.y + drag!.offsetY } } };
      });
    if (cmds.length) dispatch(cmds, "move");
  } else if (drag.mode === "create" && preview && drag.pageId) {
    const pageId = drag.pageId;
    const page = docStore.doc.nodes[pageId];
    const x0 = Math.min(preview.x, preview.x + preview.w);
    const y0 = Math.min(preview.y, preview.y + preview.h);
    const w = Math.max(8, Math.abs(preview.w));
    const h = Math.max(8, Math.abs(preview.h));
    const tool = ui.tool as "frame" | "rect" | "ellipse" | "line" | "text";
    const node = createNode(tool, {
      name: TOOL_NAMES[tool] ?? tool,
      x: x0 - page.x,
      y: y0 - page.y,
      width: w,
      height: h,
      style: { fill: { token: "color/primary" } },
    });
    let startEdit = false;
    if (tool === "text") {
      // 文本：自动尺寸 + 与界面一致的字体，创建后直接进入编辑（全选）
      const size = measureTextSize("文本", DEFAULT_TEXT_FONT_SIZE, DEFAULT_TEXT_FONT_FAMILY);
      node.text = "文本";
      node.width = size.width;
      node.height = size.height;
      node.style = {
        fill: { token: "color/text" },
        fontSize: DEFAULT_TEXT_FONT_SIZE,
        fontFamily: DEFAULT_TEXT_FONT_FAMILY,
      };
      startEdit = true;
    }
    dispatch({ type: "node.create", params: { nodes: [node], parentId: pageId } }, "create");
    ui.tool = "select";
    select([node.id]);
    preview = null;
    drag = null;
    guideLines = [];
    gapMarks = [];
    markDirty();
    if (startEdit) startTextEdit(node, true);
    return;
  }
  preview = null;
  drag = null;
  guideLines = [];
  gapMarks = [];
  markDirty();
}

function clampZoom(z: number): number {
  return Math.min(8, Math.max(0.05, z));
}

/** 以屏幕锚点缩放（滚轮在光标处，按钮在视口中心）。 */
function zoomAt(anchorX: number, anchorY: number, factor: number) {
  commitEditors();
  const before = screenToWorld(vp, anchorX, anchorY);
  vp.zoom = clampZoom(vp.zoom * factor);
  const after = screenToWorld(vp, anchorX, anchorY);
  vp.x += before.x - after.x;
  vp.y += before.y - after.y;
  markDirty();
}

/** 缩放锚点：按钮类缩放用——编辑模式锚活动页中心，拖动模式锚视口中心。 */
function zoomAnchor(): { x: number; y: number } {
  if (ui.mode === "edit") {
    const page = activePage();
    if (page) {
      const c = worldToScreen(vp, page.x + page.width / 2, page.y + page.height / 2);
      return { x: c.x, y: c.y };
    }
  }
  return { x: vp.width / 2, y: vp.height / 2 };
}

function zoomStep(factor: number) {
  const a = zoomAnchor();
  zoomAt(a.x, a.y, factor);
}

function resetZoom() {
  const a = zoomAnchor();
  zoomAt(a.x, a.y, 1 / vp.zoom);
}

function applyPresetZoom(preset: number) {
  const a = zoomAnchor();
  zoomAt(a.x, a.y, preset / vp.zoom);
  zoomMenuOpen.value = false;
}

function isCurrentZoom(preset: number): boolean {
  return Math.abs(vp.zoom - preset) < 0.005;
}

/** 滚轮事件换算成 CSS 像素（行/页模式折算）。 */
function wheelPixels(e: WheelEvent): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vp.height : 1;
  return { dx: e.deltaX * unit, dy: e.deltaY * unit };
}

/**
 * 滚轮 = 平移（⇧ 改横向）；⌘/Ctrl + 滚轮 = 以光标为锚缩放。
 * 两种模式一致：编辑模式可以滚动，但仍不允许拖拽平移（ADR-0010 收窄）。
 */
function onWheel(e: WheelEvent) {
  e.preventDefault();
  const { dx, dy } = wheelPixels(e);
  if (!dx && !dy) return;
  if (e.metaKey || e.ctrlKey) {
    const rect = canvasRef.value!.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-dy * 0.0025));
    return;
  }
  const mx = e.shiftKey ? dx || dy : dx;
  const my = e.shiftKey ? 0 : dy;
  vp.x += mx / vp.zoom;
  vp.y += my / vp.zoom;
  markDirty();
}

/** 画布只保留 Esc 的分层退出；其余快捷键由 shortcuts.ts 统一分发。 */
function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
  if (e.type !== "keydown" || e.key !== "Escape") return;

  if (zoomMenuOpen.value) {
    zoomMenuOpen.value = false;
    return;
  }
  if (textEdit.value) {
    cancelTextEdit();
    return;
  }
  if (pageRename.value) {
    cancelPageRename();
    return;
  }
  if (ui.selection.length) {
    select([]);
    return;
  }
  if (ui.mode === "edit") {
    switchMode("pan");
    return;
  }
}

/* ---------- 快捷键执行器 ---------- */

function pickTool(kind: typeof ui.tool) {
  switchMode("edit");
  ui.tool = kind;
  clearHover();
}

function deleteSelection() {
  const ids = ui.selection.filter((id) => docStore.doc.nodes[id]?.type !== "page");
  if (!ids.length) return;
  dispatch(ids.map((id) => ({ type: "node.delete" as const, params: { nodeId: id } })), "delete");
  select(ui.selection.filter((s) => !ids.includes(s)));
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

let unsub = () => {};
let ro: ResizeObserver | null = null;
let stopModeWatch = () => {};
let stopShortcuts = () => {};

onMounted(() => {
  ctx = canvasRef.value!.getContext("2d");
  backend = new Canvas2DBackend(ctx!);
  hooks.getScreenshot = async () => canvasRef.value!.toDataURL("image/png");
  hooks.focusNode = focusNode;
  hooks.focusPage = focusPage;
  hooks.getActivePageId = () => {
    if (ui.mode === "edit") return ensureActivePage()?.id ?? null;
    return pageAtViewportCenter()?.id ?? null;
  };
  hooks.requestRedraw = markDirty;
  unsub = docStore.subscribe(markDirty);
  stopShortcuts = registerShortcuts({
    "mode.pan": () => {
      switchMode("pan");
      clearHover();
    },
    "mode.edit": () => pickTool("select"),
    "tool.frame": () => pickTool("frame"),
    "tool.rect": () => pickTool("rect"),
    "tool.ellipse": () => pickTool("ellipse"),
    "tool.line": () => pickTool("line"),
    "tool.text": () => pickTool("text"),
    "edit.undo": () => docStore.undo(),
    "edit.redo": () => docStore.redo(),
    "edit.delete": deleteSelection,
    "view.zoomIn": () => zoomStep(1.2),
    "view.zoomOut": () => zoomStep(1 / 1.2),
    "view.zoomReset": resetZoom,
    "view.fit": () => fitView(),
  });
  stopModeWatch = watch(
    () => ui.mode,
    (mode) => {
      commitEditors();
      clearHover();
      // 切换模式时丢弃任何进行中的手势，避免残留在另一种模式里继续生效
      drag = null;
      preview = null;
      resizePreview = null;
      guideLines = [];
      gapMarks = [];
      dragging.value = false;
      if (mode === "edit") {
        const page = ensureActivePage();
        // 现在编辑模式也能滚动了：只有活动页看不见（或几乎看不见）才强制适配
        if (page && visibleRatio(page) < 0.15) fitActivePage();
      }
      markDirty();
    },
  );
  ro = new ResizeObserver(resize);
  ro.observe(canvasRef.value!.parentElement!);
  resize();
  raf = requestAnimationFrame(loop);
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  unsub();
  stopModeWatch();
  stopShortcuts();
  ro?.disconnect();
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div class="viewport">
    <canvas
      ref="canvasRef"
      class="canvas"
      :style="{ cursor }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="onPointerLeave"
      @dblclick="onDoubleClick"
      @wheel.prevent="onWheel"
    />

    <!-- 页面名称行内改名 -->
    <input
      v-if="pageRename"
      ref="renameEl"
      v-model="pageRename.value"
      class="rename-input"
      spellcheck="false"
      :style="{ left: pageRename.left + 'px', top: pageRename.top + 'px', width: pageRename.width + 'px' }"
      @keydown="onRenameKey"
      @blur="commitPageRename"
    />

    <!-- 文本节点行内编辑 -->
    <textarea
      v-if="textEdit"
      ref="textEditEl"
      v-model="textEdit.value"
      class="text-edit"
      spellcheck="false"
      wrap="off"
      :style="{
        left: textEdit.left + 'px',
        top: textEdit.top + 'px',
        width: textEdit.width + 'px',
        height: textEdit.height + 'px',
        fontSize: textEdit.fontSize * textEdit.scale + 'px',
        fontFamily: textEdit.fontFamily,
        fontWeight: textEdit.fontWeight,
        lineHeight: TEXT_LINE_HEIGHT,
      }"
      @input="syncTextEditSize"
      @keydown="onTextEditKey"
      @blur="commitTextEdit"
    />

    <div class="zoom-bar glass">
      <button v-tip="{ label: '缩小', shortcut: keyOf('view.zoomOut') }" @click="zoomStep(1 / 1.2)">−</button>
      <button class="zoom-pct" v-tip="{ label: '选择缩放比例' }" @click="zoomMenuOpen = !zoomMenuOpen">{{ zoomPct }}%</button>
      <button v-tip="{ label: '放大', shortcut: keyOf('view.zoomIn') }" @click="zoomStep(1.2)">＋</button>
      <span class="z-divider" />
      <button class="z-fit" v-tip="{ label: ui.mode === 'edit' ? '适配活动页' : '适配全部', shortcut: keyOf('view.fit') }" @click="fitView()">
        <Icon name="fit" :size="13" />
      </button>
    </div>

    <div v-if="zoomMenuOpen" class="zoom-backdrop" @click="zoomMenuOpen = false" />
    <div v-if="zoomMenuOpen" class="zoom-menu">
      <button v-for="z in ZOOM_PRESETS" :key="z" @click="applyPresetZoom(z)">
        <span>{{ Math.round(z * 100) }}%</span>
        <span v-if="isCurrentZoom(z)" class="check">✓</span>
      </button>
      <span class="z-menu-divider" />
      <button @click="fitView(); zoomMenuOpen = false">
        <span>{{ ui.mode === "edit" ? "适配活动页" : "适配全部" }}</span>
        <span class="check"><Icon name="fit" :size="11" /></span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.viewport {
  position: absolute;
  inset: 0;
}

.canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
}

/* 页面名称行内改名（与画布标签同位置、同字号） */
.rename-input {
  position: absolute;
  z-index: 8;
  height: 18px;
  box-sizing: border-box;
  padding: 0 5px;
  border: 1px solid var(--accent-line);
  border-radius: 6px;
  background: #ffffff;
  color: rgba(23, 23, 28, 0.78);
  font-size: 11px;
  font-family: "Geist Variable", "PingFang SC", sans-serif;
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* 文本行内编辑：透明底 + 细描边，字与画布渲染对齐 */
.text-edit {
  position: absolute;
  z-index: 8;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 2px;
  background: transparent;
  box-shadow:
    0 0 0 1px var(--accent-line),
    0 0 0 4px rgba(79, 70, 229, 0.1);
  color: var(--text);
  white-space: pre;
  overflow: hidden;
  resize: none;
  outline: none;
}

.zoom-bar {
  position: absolute;
  right: 306px;
  bottom: 22px;
  z-index: 7;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 3px 4px;
  border-radius: var(--radius-pill);
  background: rgba(255, 255, 255, 0.92);
}

.zoom-backdrop {
  position: absolute;
  inset: 0;
  z-index: 5;
}

.zoom-menu {
  position: absolute;
  right: 306px;
  bottom: 58px;
  z-index: 6;
  min-width: 132px;
  padding: 4px;
  background: #ffffff;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-md);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.16);
  animation: zoom-menu-in 160ms var(--ease) both;
}

@keyframes zoom-menu-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.zoom-menu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 11.5px;
  font-family: var(--mono);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.zoom-menu button:hover {
  background: rgba(15, 23, 42, 0.05);
  color: var(--text);
}

.zoom-menu .check {
  color: var(--accent);
  font-size: 10px;
  display: grid;
  place-items: center;
}

.z-menu-divider {
  display: block;
  height: 1px;
  background: var(--hairline);
  margin: 4px 6px;
}

.zoom-bar button {
  display: grid;
  place-items: center;
  height: 24px;
  min-width: 24px;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--text-dim);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.zoom-bar button:hover {
  background: rgba(15, 23, 42, 0.06);
  color: var(--text);
}

.zoom-pct {
  min-width: 46px !important;
  font-family: var(--mono) !important;
  font-size: 10.5px !important;
}

.z-divider {
  width: 1px;
  height: 14px;
  background: var(--hairline);
  margin: 0 2px;
}
</style>
