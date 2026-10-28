<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { createNode, type NodeId } from "@sqraft/core";
import { Canvas2DBackend, drawDocument, screenToWorld, worldToScreen, type Viewport } from "@sqraft/render";
import { currentPageId, dispatch, docStore, hooks, select, ui } from "../store";

const canvasRef = ref<HTMLCanvasElement | null>(null);
const vp: Viewport = { x: -200, y: -150, zoom: 1, width: 800, height: 600, dpr: window.devicePixelRatio || 1 };

let ctx: CanvasRenderingContext2D | null = null;
let backend: Canvas2DBackend | null = null;
let raf = 0;
let dirty = true;
let drag: { pointerId: number; mode: "pan" | "create" | "move"; startX: number; startY: number; startWX: number; startWY: number; offsetX: number; offsetY: number } | null = null;
let preview: { x: number; y: number; w: number; h: number } | null = null;
const spaceDown = ref(false);

const TOOL_NAMES: Record<string, string> = { frame: "画板", rect: "矩形", ellipse: "椭圆", line: "直线", text: "文本" };

const cursor = computed(() => {
  if (spaceDown.value) return "grab";
  return ui.tool === "select" ? "default" : "crosshair";
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
  g.fillStyle = "rgba(255, 255, 255, 0.085)";
  for (let x = offX; x < v.width; x += step) {
    for (let y = offY; y < v.height; y += step) {
      g.fillRect(x, y, 1.3, 1.3);
    }
  }
  g.restore();
}

function draw() {
  if (!ctx || !backend) return;
  const pageId = currentPageId();
  if (!pageId) return;

  backend.beginFrame(vp);
  drawGrid(ctx, vp);
  drawDocument(backend, docStore.doc, pageId);
  backend.endFrame();

  // 覆盖层：选中框 / 手柄 / 尺寸徽标 / 拖拽预览（屏幕空间）
  ctx.save();
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);

  for (const id of ui.selection) {
    const n = docStore.doc.nodes[id];
    if (!n) continue;
    const p = drag && drag.mode === "move" ? { x: n.x + drag.offsetX, y: n.y + drag.offsetY } : { x: n.x, y: n.y };
    const a = worldToScreen(vp, p.x, p.y);
    const b = worldToScreen(vp, p.x + n.width, p.y + n.height);

    ctx.strokeStyle = "#8b8df5";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);

    // 四角手柄
    for (const [hx, hy] of [
      [a.x, a.y],
      [b.x, a.y],
      [a.x, b.y],
      [b.x, b.y],
    ]) {
      ctx.beginPath();
      ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#0b0b0e";
      ctx.fill();
      ctx.strokeStyle = "#8b8df5";
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }

    // 单选时显示尺寸徽标
    if (ui.selection.length === 1) {
      const label = `${Math.round(n.width)} × ${Math.round(n.height)}`;
      ctx.font = "10.5px 'Geist Mono Variable', ui-monospace, monospace";
      const tw = ctx.measureText(label).width;
      const bw = tw + 14;
      const bh = 19;
      const bx = (a.x + b.x) / 2 - bw / 2;
      const by = a.y - bh - 8;
      ctx.beginPath();
      (ctx as unknown as { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(bx, by, bw, bh, 5);
      ctx.fillStyle = "#6366f1";
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, bx + bw / 2, by + bh / 2 + 0.5);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
  }

  if (preview) {
    const a = worldToScreen(vp, Math.min(preview.x, preview.x + preview.w), Math.min(preview.y, preview.y + preview.h));
    const b = worldToScreen(vp, Math.max(preview.x, preview.x + preview.w), Math.max(preview.y, preview.y + preview.h));
    ctx.fillStyle = "rgba(124, 127, 242, 0.10)";
    ctx.strokeStyle = "rgba(139, 141, 245, 0.75)";
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 4]);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function loop() {
  if (dirty) {
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
    markDirty();
  }
}

function hitTest(wx: number, wy: number): NodeId | null {
  const pageId = currentPageId();
  if (!pageId) return null;
  let hit: NodeId | null = null;
  const visit = (id: NodeId) => {
    const n = docStore.doc.nodes[id];
    if (!n || !n.visible || n.type === "page") return;
    for (const c of n.children) visit(c);
    if (!hit && wx >= n.x && wx <= n.x + n.width && wy >= n.y && wy <= n.y + n.height) hit = n.id;
  };
  for (const c of docStore.doc.nodes[pageId].children) visit(c);
  return hit;
}

function onPointerDown(e: PointerEvent) {
  const rect = canvasRef.value!.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const w = screenToWorld(vp, sx, sy);
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  const base = { pointerId: e.pointerId, startX: sx, startY: sy, startWX: vp.x, startWY: vp.y, offsetX: 0, offsetY: 0 };
  if (e.button === 1 || spaceDown.value) {
    drag = { ...base, startX: sx, startY: sy, mode: "pan" };
    return;
  }
  if (ui.tool === "select") {
    const id = hitTest(w.x, w.y);
    if (id) {
      if (!ui.selection.includes(id)) select([id]);
      drag = { ...base, startX: w.x, startY: w.y, mode: "move" };
    } else {
      select([]);
    }
    return;
  }
  drag = { ...base, startX: w.x, startY: w.y, mode: "create" };
  preview = { x: w.x, y: w.y, w: 0, h: 0 };
}

function onPointerMove(e: PointerEvent) {
  if (!drag) return;
  // 只认发起拖拽的那个指针，且必须仍按着键（滤除真实鼠标划过等杂散事件）
  if (e.pointerId !== drag.pointerId || e.buttons === 0) return;
  const rect = canvasRef.value!.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const w = screenToWorld(vp, sx, sy);
  if (drag.mode === "pan") {
    vp.x = drag.startWX - (sx - drag.startX) / vp.zoom;
    vp.y = drag.startWY - (sy - drag.startY) / vp.zoom;
  } else if (drag.mode === "move") {
    drag.offsetX = w.x - drag.startX;
    drag.offsetY = w.y - drag.startY;
  } else if (drag.mode === "create" && preview) {
    preview = { x: drag.startX, y: drag.startY, w: w.x - drag.startX, h: w.y - drag.startY };
  }
  markDirty();
}

function onPointerUp() {
  if (!drag) return;
  if (drag.mode === "move" && (drag.offsetX || drag.offsetY)) {
    const ids = [...ui.selection];
    const cmds = ids
      .filter((id) => docStore.doc.nodes[id])
      .map((id) => {
        const n = docStore.doc.nodes[id];
        return { type: "node.update" as const, params: { nodeId: id, patch: { x: n.x + drag!.offsetX, y: n.y + drag!.offsetY } } };
      });
    if (cmds.length) dispatch(cmds, "move");
  } else if (drag.mode === "create" && preview) {
    const pageId = currentPageId();
    const x = Math.min(preview.x, preview.x + preview.w);
    const y = Math.min(preview.y, preview.y + preview.h);
    const w = Math.max(8, Math.abs(preview.w));
    const h = Math.max(8, Math.abs(preview.h));
    const node = createNode(ui.tool, { name: TOOL_NAMES[ui.tool] ?? ui.tool, x, y, width: w, height: h, style: { fill: { token: "color/primary" } } });
    if (ui.tool === "text") {
      node.text = "文本";
      node.style.fontSize = 16;
      node.style.fill = { token: "color/text" };
    }
    dispatch({ type: "node.create", params: { nodes: [node], parentId: pageId! } }, "create");
    ui.tool = "select";
    select([node.id]);
    preview = null;
  }
  drag = null;
  markDirty();
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const rect = canvasRef.value!.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const before = screenToWorld(vp, sx, sy);
  vp.zoom = Math.min(8, Math.max(0.05, vp.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
  const after = screenToWorld(vp, sx, sy);
  vp.x += before.x - after.x;
  vp.y += before.y - after.y;
  markDirty();
}

function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
  if (e.code === "Space") {
    spaceDown.value = e.type === "keydown";
    e.preventDefault();
    return;
  }
  if (e.type !== "keydown") return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? docStore.redo() : docStore.undo();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && ui.selection.length) {
    const ids = [...ui.selection];
    dispatch(ids.map((id) => ({ type: "node.delete" as const, params: { nodeId: id } })), "delete");
    select([]);
    return;
  }
  const map: Record<string, string> = { v: "select", f: "frame", r: "rect", o: "ellipse", l: "line", t: "text" };
  const tool = map[e.key.toLowerCase()];
  if (tool && !e.metaKey && !e.ctrlKey) ui.tool = tool as typeof ui.tool;
}

let unsub = () => {};
let ro: ResizeObserver | null = null;

onMounted(() => {
  ctx = canvasRef.value!.getContext("2d");
  backend = new Canvas2DBackend(ctx!);
  hooks.getScreenshot = async () => canvasRef.value!.toDataURL("image/png");
  unsub = docStore.subscribe(markDirty);
  ro = new ResizeObserver(resize);
  ro.observe(canvasRef.value!.parentElement!);
  resize();
  raf = requestAnimationFrame(loop);
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  unsub();
  ro?.disconnect();
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("keyup", onKey);
});
</script>

<template>
  <canvas
    ref="canvasRef"
    class="canvas"
    :style="{ cursor }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @wheel.prevent="onWheel"
  />
</template>

<style scoped>
.canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
}
</style>
