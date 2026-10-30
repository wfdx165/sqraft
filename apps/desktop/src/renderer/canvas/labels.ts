/**
 * 根节点名称标签：页面与主组件的画布叠加层绘制与命中。
 *
 * 标签是编辑模式下移动整页 / 整块母版的唯一入口：母版的子节点常常铺满
 * 整个矩形，画布上没有任何像素能命中母版本体，只能靠标签抓。
 * 因此命中与绘制共用同一几何计算（`rootLabelRect` / `chipRect`）。
 */
import type { DocNode, Rect } from "@sqraft/core";
import { worldToScreen, type Viewport } from "@sqraft/render";
import { ICON_PATHS, ICON_STROKE, ICON_VIEWBOX } from "../icons";
import { docStore } from "../store";
import {
  LABEL_CHIP_ABOVE,
  LABEL_CHIP_HEIGHT,
  LABEL_CHIP_MIN_Y,
  LABEL_CHIP_OFFSET_X,
  LABEL_CHIP_PAD_L,
  LABEL_CHIP_RADIUS,
  LABEL_FONT,
  LABEL_ICON_GAP,
  LABEL_ICON_SIZE,
  labelChipWidth,
} from "./label-metrics";
import { LIBRARY_ACCENT } from "./selection-overlay";

const ACTIVE_PAGE_ALPHA = 0.35;

export interface RootLabelDrawOptions {
  /** 行内改名中的节点（隐藏它的标签，输入框取而代之） */
  renameId: string | null;
  drag: { mode: string; moved: boolean; offsetX: number; offsetY: number } | null;
  resizePreview: { id: string; x: number; y: number; width: number; height: number } | null;
  selection: readonly string[];
  activePageId: string | null;
  mode: string;
}

/** 标签定位需要的预览状态（拖动 / 缩放时不改文档，只偏移标签）。 */
export interface LabelOriginOptions {
  drag: RootLabelDrawOptions["drag"];
  resizePreview: RootLabelDrawOptions["resizePreview"];
  selection: readonly string[];
}

/** 标签锚点（= 节点左上角的世界坐标，含拖动 / 缩放预览偏移）。 */
export function labelOrigin(node: DocNode, opts: LabelOriginOptions): { x: number; y: number } {
  const moving = Boolean(opts.drag && opts.drag.mode === "move" && opts.drag.moved && opts.selection.includes(node.id));
  const rp = opts.resizePreview && opts.resizePreview.id === node.id ? opts.resizePreview : null;
  return {
    x: (rp ? rp.x : node.x) + (moving ? opts.drag!.offsetX : 0),
    y: (rp ? rp.y : node.y) + (moving ? opts.drag!.offsetY : 0),
  };
}

/* ---------------- 文本宽度：按名称缓存 ---------------- */

const measuredWidths = new Map<string, number>();
let fontsHookInstalled = false;
/** 字体加载完成后清一次缓存：加载前的量宽会落成回退字体。 */
function hookFontsReady(): void {
  if (fontsHookInstalled) return;
  fontsHookInstalled = true;
  if (typeof document === "undefined" || !document.fonts?.ready) return;
  void document.fonts.ready.then(() => measuredWidths.clear());
}

/**
 * 标签文本宽度（屏幕 px）：
 * - 有 ctx 时按标签字体实测，并按名称缓存（字号固定，与缩放 / dpr 无关）；
 * - 没有 ctx 时按 11px/字估算（无 canvas 的兜底与单测）。
 */
function labelTextWidth(name: string, vp: Viewport, ctx: CanvasRenderingContext2D | null): number {
  if (!ctx) return name.length * 11;
  const key = `m:${name}`;
  const cached = measuredWidths.get(key);
  if (cached !== undefined) return cached;
  hookFontsReady();
  ctx.save();
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  ctx.font = LABEL_FONT;
  const width = ctx.measureText(name).width;
  ctx.restore();
  measuredWidths.set(key, width);
  return width;
}

/* ---------------- 几何 ---------------- */

/** chip 屏幕矩形：统一在这里夹到视口顶部，绘制与命中必须走同一个函数。 */
function chipRect(screen: { x: number; y: number }, textWidth: number): Rect {
  return {
    x: screen.x + LABEL_CHIP_OFFSET_X,
    y: Math.max(LABEL_CHIP_MIN_Y, screen.y - LABEL_CHIP_ABOVE),
    width: labelChipWidth(textWidth),
    height: LABEL_CHIP_HEIGHT,
  };
}

/** 节点在屏幕上的纵向跨度（忽略旋转，与标签定位的口径一致）。 */
function screenSpan(
  node: DocNode,
  vp: Viewport,
  origin: { x: number; y: number },
): { top: number; bottom: number } {
  const top = worldToScreen(vp, origin.x, origin.y).y;
  return { top, bottom: top + node.height * vp.zoom };
}

/** 圆角矩形（Chromium 的 roundRect 在类型里还没进 lib，统一走这里）。 */
function roundRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  (g as unknown as { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(x, y, w, h, r);
}

/* ---------------- 图标 ---------------- */

const iconCache = new Map<string, Path2D>();

function iconPath(name: string): Path2D | null {
  const d = ICON_PATHS[name];
  if (!d) return null;
  let path = iconCache.get(name);
  if (!path) {
    path = new Path2D(d);
    iconCache.set(name, path);
  }
  return path;
}

/** 标签图标：与 DOM 图标共用同一份路径（`icons.ts`），形状与线宽都从那里推导。 */
function paintLabelIcon(
  g: CanvasRenderingContext2D,
  name: "component" | "pages",
  x: number,
  y: number,
  color: string,
): void {
  const path = iconPath(name);
  if (!path) return;
  const scale = LABEL_ICON_SIZE / ICON_VIEWBOX;
  g.save();
  g.translate(x, y);
  g.scale(scale, scale);
  g.strokeStyle = color;
  // 缩到 12px 后 1.25 的描边只剩 0.6px，半透明底上会发虚：按 1.5 倍加粗（仍由 ICON_STROKE 驱动）
  g.lineWidth = ICON_STROKE * 1.5;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.stroke(path);
  g.restore();
}

/* ---------------- 绘制 ---------------- */

export function drawRootLabels(g: CanvasRenderingContext2D, vp: Viewport, opts: RootLabelDrawOptions): void {
  g.save();
  g.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  g.font = LABEL_FONT;
  g.textBaseline = "middle";
  // 页面在前、母版在后：母版标签永远在最上层
  paintRootLabels(g, vp, opts, "page");
  paintRootLabels(g, vp, opts, "component");
  g.restore();
}

function paintRootLabels(
  g: CanvasRenderingContext2D,
  vp: Viewport,
  opts: RootLabelDrawOptions,
  type: "page" | "component",
): void {
  const roots = docStore.doc.rootIds;
  for (const id of roots) {
    const node = docStore.doc.nodes[id];
    if (!node || node.type !== type || !node.visible) continue;
    if (opts.renameId === node.id) continue;
    const origin = labelOrigin(node, opts);
    const screen = worldToScreen(vp, origin.x, origin.y);
    // 整块在视口上方：标签会浮在没有对象的地方（命中同样跳过）
    if (screen.y + node.height * vp.zoom < 0) continue;
    if (screen.x > vp.width || screen.y > vp.height + 40) continue;
    const library = node.type === "component";
    const selected = opts.selection.includes(node.id);
    const rect = chipRect(screen, labelTextWidth(node.name, vp, g));
    g.globalAlpha = !library && opts.mode === "edit" && opts.activePageId !== node.id ? ACTIVE_PAGE_ALPHA : 1;
    g.beginPath();
    roundRectPath(g, rect.x, rect.y, rect.width, rect.height, LABEL_CHIP_RADIUS);
    g.fillStyle = library
      ? selected
        ? "rgba(139, 92, 246, 0.20)"
        : "rgba(139, 92, 246, 0.12)"
      : "rgba(255, 255, 255, 0.78)";
    g.fill();
    if (library) {
      g.strokeStyle = selected ? "rgba(139, 92, 246, 0.55)" : "rgba(139, 92, 246, 0.30)";
      g.lineWidth = 1;
      g.stroke();
    }
    paintLabelIcon(
      g,
      library ? "component" : "pages",
      rect.x + LABEL_CHIP_PAD_L,
      rect.y + (LABEL_CHIP_HEIGHT - LABEL_ICON_SIZE) / 2,
      library ? LIBRARY_ACCENT : "rgba(23, 23, 28, 0.45)",
    );
    g.fillStyle = library ? "#6d28d9" : "rgba(23, 23, 28, 0.62)";
    g.fillText(
      node.name,
      rect.x + LABEL_CHIP_PAD_L + LABEL_ICON_SIZE + LABEL_ICON_GAP,
      rect.y + LABEL_CHIP_HEIGHT / 2 + 0.5,
    );
    g.globalAlpha = 1;
  }
}

/* ---------------- 命中 ---------------- */

/**
 * 根节点名称标签的屏幕矩形。
 * 节点整块在视口上方时返回 null（没有可抓的标签）。
 */
export function rootLabelRect(
  node: DocNode,
  vp: Viewport,
  ctx: CanvasRenderingContext2D | null,
): Rect | null {
  const span = screenSpan(node, vp, { x: node.x, y: node.y });
  if (span.bottom < 0) return null;
  return chipRect(worldToScreen(vp, node.x, node.y), labelTextWidth(node.name, vp, ctx));
}

/** 命中根节点标签：母版优先（画在上层），其次页面。 */
export function labelAt(
  sx: number,
  sy: number,
  vp: Viewport,
  ctx: CanvasRenderingContext2D | null,
): DocNode | null {
  for (const type of ["component", "page"] as const) {
    const roots = docStore.doc.rootIds;
    // 同类型里后画的在上层
    for (let i = roots.length - 1; i >= 0; i--) {
      const node = docStore.doc.nodes[roots[i]];
      if (!node || node.type !== type || !node.visible) continue;
      const r = rootLabelRect(node, vp, ctx);
      if (!r) continue;
      if (sx >= r.x && sx <= r.x + r.width && sy >= r.y && sy <= r.y + r.height) return node;
    }
  }
  return null;
}
