<script setup lang="ts">
/**
 * 演示模式：全窗口覆盖层，一次只画一个页面。
 *
 * 纪律：
 * - 只读文档，不写任何命令（退出时撤销栈、选区、缩放都不变）；
 * - 命中从页面子树向下找，再**向上冒泡**到最近带 click 交互的祖先；
 * - 转场 `dissolve` 是"旧屏截图淡出"，不碰文档几何。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Canvas2DBackend, drawDocument, type Viewport } from "@sqraft/render";
import { worldRect, type DocNode, type Interaction, type NodeId } from "@sqraft/core";
import { hitShapeAt, toLocal } from "../canvas/hit";
import { pageFitViewport } from "../canvas/viewport-fit";
import { imageFor } from "../assets";
import { linkedImage } from "../linked-images";
import { docStore, ui } from "../store";
import { clampScroll, exitPresenter, goBack, jumpTo, scrollPresentPage } from "../presenter";
import { t } from "../i18n";
import Icon from "./Icon.vue";

const PADDING = 48;
// 文案跟着 locale 走：t() 读的是响应式 locale.value，用 computed 才不会在 setup 时被快照
const HINT = computed(() => t("present.exitHint"));
const EXIT_LABEL = computed(() => t("present.exit"));

const canvasEl = ref<HTMLCanvasElement | null>(null);
const hot = ref(false);
const highlight = ref(false);

let ctx: CanvasRenderingContext2D | null = null;
let backend: Canvas2DBackend | null = null;
let raf = 0;
let dirty = true;
let vp: Viewport = { x: 0, y: 0, zoom: 1, width: 1, height: 1, dpr: 1 };
/** 页面在屏幕上的裁切框（不含滚动位移）。 */
let focus = { x: 0, y: 0, width: 0, height: 0 };
let transition: { canvas: HTMLCanvasElement; start: number; duration: number } | null = null;
/** 最近一次指针位置（CSS 像素）：跳转后要立刻刷新光标，不能等人动鼠标 */
let pointer = { x: 0, y: 0 };

const markDirty = (): void => {
  dirty = true;
};

function page(): DocNode | null {
  const state = ui.presenter;
  if (!state) return null;
  return docStore.doc.nodes[state.pageId] ?? null;
}

function inside(node: DocNode, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x <= node.width && y <= node.height;
}

/** 视口：页面居中适配；滚动只改视口原点，裁切框固定不动。 */
function layout(): void {
  const canvas = canvasEl.value;
  const current = page();
  if (!canvas || !current) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth));
  const height = Math.max(1, Math.round(canvas.clientHeight));
  const fit = pageFitViewport(
    { x: current.x, y: current.y, width: current.width, height: current.height },
    { width, height },
    PADDING,
  );
  const scroll = clampScroll(current, ui.presenter?.scroll ?? 0);
  if (ui.presenter) ui.presenter.scroll = scroll;
  const horizontal = current.scrollDirection === "horizontal";
  vp = {
    x: fit.x + (horizontal ? scroll : 0),
    y: fit.y + (horizontal ? 0 : scroll),
    zoom: fit.zoom,
    width,
    height,
    dpr,
  };
  focus = {
    x: (current.x - fit.x) * fit.zoom,
    y: (current.y - fit.y) * fit.zoom,
    width: current.width * fit.zoom,
    height: current.height * fit.zoom,
  };
}

/** 页面子树里的最深命中；容器自身作为兜底。 */
function hitInside(parentId: NodeId, lx: number, ly: number): NodeId | null {
  const parent = docStore.doc.nodes[parentId];
  if (!parent) return null;
  const clipped =
    parent.clip && (parent.type === "frame" || parent.type === "component" || parent.type === "instance");
  if (clipped && !inside(parent, lx, ly)) return null;
  for (let i = parent.children.length - 1; i >= 0; i -= 1) {
    const child = docStore.doc.nodes[parent.children[i]];
    if (!child || !child.visible) continue;
    const local = toLocal(child, lx, ly);
    const shape = hitShapeAt(child, local.x, local.y, 5 / vp.zoom);
    if (shape !== null) {
      if (shape) return child.id;
      continue;
    }
    if (!inside(child, local.x, local.y)) continue;
    return hitInside(child.id, local.x, local.y) ?? child.id;
  }
  return null;
}

/** 屏幕坐标 → 热区交互：先找最深节点，再向上冒泡到最近的点击链接。 */
function linkAt(sx: number, sy: number): Interaction | null {
  const current = page();
  if (!current) return null;
  if (sx < focus.x || sy < focus.y || sx > focus.x + focus.width || sy > focus.y + focus.height) return null;
  const wx = vp.x + sx / vp.zoom;
  const wy = vp.y + sy / vp.zoom;
  const hitId = hitInside(current.id, wx - current.x, wy - current.y);
  let cur = hitId ? docStore.doc.nodes[hitId] : null;
  while (cur && cur.id !== current.id) {
    const link = cur.interactions?.find((item) => item.trigger === "click");
    if (link) return link;
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : null;
  }
  return null;
}

function capture(): HTMLCanvasElement | null {
  const canvas = canvasEl.value;
  if (!canvas) return null;
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext("2d")?.drawImage(canvas, 0, 0);
  return copy;
}

function navigate(link: Interaction): void {
  if (link.action === "back") {
    if (goBack()) {
      markDirty();
      syncHot();
    }
    return;
  }
  const target = link.targetId ? docStore.doc.nodes[link.targetId] : null;
  if (!target || target.type !== "page") return;
  const dissolve = link.transition.type === "dissolve" && link.transition.durationMs > 0;
  const previous = dissolve ? capture() : null;
  jumpTo(target.id);
  if (previous) {
    transition = { canvas: previous, start: performance.now(), duration: link.transition.durationMs };
  }
  markDirty();
  syncHot();
}

function drawHotspots(c: CanvasRenderingContext2D, current: DocNode): void {
  c.save();
  c.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  c.fillStyle = "rgba(37, 99, 235, 0.22)";
  c.strokeStyle = "rgba(96, 165, 250, 0.9)";
  c.lineWidth = 1;
  const visit = (node: DocNode): void => {
    for (const childId of node.children) {
      const child = docStore.doc.nodes[childId];
      if (!child || !child.visible) continue;
      if (child.interactions?.some((link) => link.trigger === "click")) {
        const box = worldRect(docStore.doc, child.id);
        if (box) {
          const x = (box.x - vp.x) * vp.zoom;
          const y = (box.y - vp.y) * vp.zoom;
          c.fillRect(x, y, box.width * vp.zoom, box.height * vp.zoom);
          c.strokeRect(x + 0.5, y + 0.5, box.width * vp.zoom - 1, box.height * vp.zoom - 1);
        }
      }
      visit(child);
    }
  };
  visit(current);
  c.restore();
}

function draw(now: number): void {
  const current = page();
  if (!ctx || !backend || !current) return;
  backend.beginFrame(vp);

  // 舞台底色（屏幕空间）
  ctx.save();
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  ctx.fillStyle = "#0c0d10";
  ctx.fillRect(0, 0, vp.width, vp.height);
  ctx.restore();

  // 页面内容：裁到页面矩形（世界坐标，滚动后的视口已经带位移）
  ctx.save();
  ctx.beginPath();
  ctx.rect(current.x, current.y, current.width, current.height);
  ctx.clip();
  drawDocument(backend, docStore.doc, {
    onlyPageIds: [current.id],
    resolveImage: (assetId) => imageFor(assetId),
    resolveLinkedImage: (url) => linkedImage(url),
  });
  ctx.restore();

  // 页面边框 + 热区提示（屏幕空间）
  ctx.save();
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
  ctx.lineWidth = 1;
  ctx.strokeRect(focus.x + 0.5, focus.y + 0.5, focus.width - 1, focus.height - 1);
  ctx.restore();
  if (highlight.value) drawHotspots(ctx, current);

  // 淡入转场：旧屏截图叠在新屏上淡出
  if (transition) {
    const progress = (now - transition.start) / Math.max(1, transition.duration);
    if (progress >= 1) {
      transition = null;
    } else {
      const eased = 1 - Math.pow(1 - progress, 3);
      ctx.save();
      ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
      ctx.globalAlpha = 1 - eased;
      ctx.drawImage(transition.canvas, 0, 0, vp.width, vp.height);
      ctx.globalAlpha = 1;
      ctx.restore();
      dirty = true;
    }
  }
}

function loop(now: number): void {
  if (dirty || transition) {
    dirty = false;
    layout();
    draw(now);
  }
  raf = requestAnimationFrame(loop);
}

function onMouseMove(e: MouseEvent): void {
  pointer = { x: e.offsetX, y: e.offsetY };
  syncHot();
}

/** 指针停在热区上显示 pointer；跳转后页面变了，光标也要跟着重算。 */
function syncHot(): void {
  const next = Boolean(linkAt(pointer.x, pointer.y));
  if (next !== hot.value) hot.value = next;
}

function onClick(e: MouseEvent): void {
  if (transition) return;
  const link = linkAt(e.offsetX, e.offsetY);
  if (link) navigate(link);
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
  const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
  scrollPresentPage(dx, dy);
  markDirty();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    exitPresenter();
    return;
  }
  if (e.key === "ArrowLeft" || e.key === "Backspace") {
    e.preventDefault();
    if (goBack()) {
      markDirty();
      syncHot();
    }
    return;
  }
  if (e.key === "h" || e.key === "H") {
    if (!highlight.value) {
      highlight.value = true;
      markDirty();
    }
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if ((e.key === "h" || e.key === "H") && highlight.value) {
    highlight.value = false;
    markDirty();
  }
}

watch(
  () => ui.version,
  () => {
    const state = ui.presenter;
    if (!state) return;
    if (!docStore.doc.nodes[state.pageId]) {
      if (!goBack()) {
        exitPresenter();
        return;
      }
    }
    markDirty();
  },
);

onMounted(() => {
  ctx = canvasEl.value?.getContext("2d") ?? null;
  backend = ctx ? new Canvas2DBackend(ctx) : null;
  layout();
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("resize", markDirty);
  canvasEl.value?.addEventListener("wheel", onWheel, { passive: false });
  raf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("keyup", onKeyUp, true);
  window.removeEventListener("resize", markDirty);
  canvasEl.value?.removeEventListener("wheel", onWheel);
});
</script>

<template>
  <div class="presenter" :class="{ hot }">
    <canvas ref="canvasEl" class="stage" @mousemove="onMouseMove" @click="onClick" @contextmenu.prevent />
    <button class="exit" :title="EXIT_LABEL" :aria-label="EXIT_LABEL" @click="exitPresenter">
      <Icon name="close" :size="14" />
    </button>
    <div class="hint">{{ HINT }}</div>
  </div>
</template>

<style scoped>
.presenter {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: #0c0d10;
}

.stage {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  cursor: default;
}

.presenter.hot .stage {
  cursor: pointer;
}

.exit {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.exit:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #ffffff;
}

.hint {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.48);
  font-size: 11px;
  letter-spacing: 0.02em;
  pointer-events: none;
}
</style>
