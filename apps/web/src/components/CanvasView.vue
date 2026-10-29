<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  firstPageId,
  makeAnchor,
  scaleVector,
  worldRect,
  type DocNode,
  type NodeId,
  type Rect,
  type VectorPath,
} from "@sqraft/core";
import { Canvas2DBackend, drawDocument, screenToWorld, worldToScreen, type Viewport } from "@sqraft/render";
import { drawDraftPath, drawPathEditing, drawShapePreview } from "../canvas/vector-overlay";
import {
  beginDraft,
  createPenState,
  finishDraft,
  pathAnchorAt,
  removeDraftAnchor,
} from "../canvas/pen";
import { dispatch, docStore, hooks, select, switchMode, ui } from "../store";
import { hitTest, isLocked, pageAt, slotUnder } from "../canvas/hit";
import { containerAt, layoutParentOf, reorderGuide, reorderIndexAt } from "../canvas/layout-drag";
import { buildCreatedNode } from "../canvas/create-drag";
import { deleteSelection as deleteSelectionAction } from "../canvas/delete-selection";
import { createDraftGuards } from "../canvas/draft-guard";
import { paintDropSlot as paintDrop, paintSlotPlaceholders as paintSlots } from "../canvas/slot-overlay";
import { drawPageLabels, labelAt, pageLabelRect } from "../canvas/labels";
import {
  handlePointsOfQuad,
  localDelta,
  resizeRect,
  selectionQuad,
  type ResizeHandle,
} from "../canvas/selection";
import { drawPulse, drawSelectionOverlay } from "../canvas/selection-overlay";
import { useTextEditing } from "../canvas/text-editing";
import { drawGrid } from "../canvas/grid";
import { FLY_MS, PULSE_MS, createViewportNav } from "../canvas/viewport-nav";
import { EQUILATERAL_RATIO, drawToolOf, type DrawTool } from "../canvas/tools";
import { cursorFor } from "../canvas/cursor";
import {
  createComponentFromSelection as createComponentFromSelectionAction,
  detachSelection as detachSelectionAction,
  insertInstance as insertInstanceAction,
} from "../canvas/component-actions";
import {
  computeGuides,
  drawGuides as paintGuides,
  guideContextFor,
  guideContextForParent,
  snapDrawRect,
  snapResizeRect,
  type GapMark,
  type GuideContext,
  type GuideLine,
} from "../canvas/guides";
import { keyOf, registerShortcuts } from "../shortcuts";
import { vTip } from "../tooltip";
import Icon from "./Icon.vue";

const canvasRef = ref<HTMLCanvasElement | null>(null);
const zoomPct = ref(100);
const zoomMenuOpen = ref(false);
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.5, 2, 4];
const vp: Viewport = { x: -200, y: -150, zoom: 1, width: 800, height: 600, dpr: window.devicePixelRatio || 1 };
const { textEdit, textEditEl, startTextEdit, commitTextEdit, cancelTextEdit, onTextEditInput, onTextEditKey } =
  useTextEditing(vp, markDirty);

const pageRename = ref<{ id: NodeId; value: string; left: number; top: number; width: number } | null>(null);
const renameEl = ref<HTMLInputElement | null>(null);
/** 悬停的文本节点（仅用于画淡虚线边界，不进文档） */
const hoverTextId = ref<NodeId | null>(null);

let ctx: CanvasRenderingContext2D | null = null;
let backend: Canvas2DBackend | null = null;
let raf = 0;
let dirty = true;

let drag: {
  pointerId: number;
  mode: "pan" | "create" | "move" | "resize" | "pen" | "vector";
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
  /** 参考线上下文（同父兄弟 + 父内容区 + 父边界；跨父容器时为 null） */
  guide?: GuideContext | null;
  /** 参与吸附的移动根矩形（拖动开始时固定，世界坐标） */
  snapRects?: Rect[];
  /** 缩放手柄与起始矩形 */
  handle?: ResizeHandle;
  /** 拖动时指针下方的实例插槽（松手即填充） */
  dropSlot?: NodeId | null;
  resizeId?: NodeId;
  startRect?: Rect;
  startAspect?: number;
  /** 缩放路径时的原始锚点（用于实时缩放预览） */
  startVector?: VectorPath;
  /** 起笔时的绘图工具：拖动中切工具也不会用新工具提交（避免造出非法节点） */
  tool?: DrawTool;
  /** 自动布局容器内的拖动 = 重排序 */
  reorderParentId?: NodeId;
  reorderIndex?: number;
} | null = null;
let preview: { x: number; y: number; w: number; h: number; valid: boolean } | null = null;

/** 钢笔 / 锚点编辑的会话状态（纯 UI 状态）。 */
const pen = createPenState();
const viewportNav = createViewportNav({ vp, pen, markDirty, commitEditors });
const { flyTo, focusRect, focusNode, focusPage, activePage, pageAtViewportCenter, ensureActivePage, setActivePage, fitAll, fitActivePage, fitView, visibleRatio } =
  viewportNav;
const componentActionDeps = { vp, ensureActivePage, markDirty };
const insertInstance = (id: NodeId) => insertInstanceAction(componentActionDeps, id);
const createComponentFromSelection = () => createComponentFromSelectionAction(componentActionDeps);
const detachSelection = () => detachSelectionAction(componentActionDeps);

const MIN_PAGE_SIZE = 200;
const MIN_NODE_SIZE = 8;
const HANDLE_HIT_PX = 7;

/** 缩放中的实时预览（不改文档） */
let resizePreview: { id: NodeId; x: number; y: number; width: number; height: number } | null = null;
let vectorPreview: { id: NodeId; vector: VectorPath } | null = null;
const hoverHandle = ref<ResizeHandle | null>(null);
const hoverInactive = ref(false);
const hoverLabel = ref(false);
const dragging = ref(false);

/* 页面参考线（世界坐标，拖拽中计算，绘制时转屏幕） */
let guideLines: GuideLine[] = [];
let gapMarks: GapMark[] = [];

const cursor = computed(() =>
  cursorFor({
    mode: ui.mode,
    tool: ui.tool,
    dragging: dragging.value,
    hoverHandle: hoverHandle.value,
    hoverLabel: hoverLabel.value,
    hoverText: Boolean(hoverTextId.value),
    hoverInactive: hoverInactive.value,
  }),
);

function markDirty() {
  dirty = true;
}

/** 钢笔逻辑的依赖：文档、UI 状态与命令入口（显式注入，模块内不 import 单例）。 */
const penDeps = { docStore, ui, dispatch, select, markDirty };

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
    hidePathId: pen.vectorDrag?.preview && pen.pathEdit ? pen.pathEdit.id : undefined,
    movePreview,
    resizePreview: editing ? (resizePreview ?? undefined) : undefined,
    vectorPreview: editing ? (vectorPreview ?? undefined) : undefined,
    dimPageIds,
  });
  backend.endFrame();

  // 覆盖层：选中框 / 手柄 / 尺寸徽标 / 拖拽预览 / 脉冲
  ctx.save();
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);

  drawSelectionOverlay(ctx, vp, {
    selection: ui.selection,
    editing,
    drag,
    resizePreview,
    textEditId: textEdit.value?.id ?? null,
    pathEditId: pen.pathEdit?.id ?? null,
    hoverTextId: hoverTextId.value,
  });

  paintPathEditing(ctx);
  drawDraftPath(ctx, vp, pen.draft, pen.penHover);
  paintGuides(ctx, vp, guideLines, gapMarks);
  paintSlots(ctx, vp, ui.activePageId, ui.mode);

  if (preview) drawShapePreview(ctx, vp, preview, drag?.tool ?? ui.tool);
  paintDrop(ctx, vp, drag?.dropSlot ?? null);

  const pulse = viewportNav.nav.pulse;
  if (pulse) {
    const n = docStore.doc.nodes[pulse.id];
    const t = (performance.now() - pulse.start) / PULSE_MS;
    if (!n || t >= 1) viewportNav.nav.pulse = null;
    else drawPulse(ctx, vp, pulse.id, t);
  }

  ctx.restore();
  drawPageLabels(ctx, vp, {
    pageRenameId: pageRename.value?.id ?? null,
    drag,
    resizePreview,
    selection: ui.selection,
    activePageId: ui.activePageId,
    mode: ui.mode,
  });
}

function loop() {
  const now = performance.now();
  const flight = viewportNav.nav.flight;
  if (flight) {
    const t = Math.min(1, (now - flight.start) / FLY_MS);
    const e = 1 - Math.pow(1 - t, 3);
    vp.x = flight.from.x + (flight.to.x - flight.from.x) * e;
    vp.y = flight.from.y + (flight.to.y - flight.from.y) * e;
    vp.zoom = flight.from.zoom + (flight.to.zoom - flight.from.zoom) * e;
    if (t >= 1) viewportNav.nav.flight = null;
    dirty = true;
  }
  const pulse = viewportNav.nav.pulse;
  if (dirty || (pulse && now - pulse.start < PULSE_MS)) {
    dirty = false;
    draw();
  }
  raf = requestAnimationFrame(loop);
}

const resize = () => viewportNav.resize(canvasRef.value);

function hitHandle(sx: number, sy: number): { handle: ResizeHandle; id: NodeId } | null {
  if (pen.pathEdit) return null;
  if (ui.mode !== "edit" || ui.tool !== "select" || ui.selection.length !== 1) return null;
  const id = ui.selection[0];
  const node = docStore.doc.nodes[id];
  if (!node || node.type === "text" || isLocked(id)) return null;
  const quad = selectionQuad(vp, id, resizePreview, drag);
  if (!quad) return null;
  for (const [handle, hx, hy] of handlePointsOfQuad(quad)) {
    if (Math.abs(sx - hx) <= HANDLE_HIT_PX && Math.abs(sy - hy) <= HANDLE_HIT_PX) return { handle, id };
  }
  return null;
}

/** 参与吸附的移动根矩形：父节点也被选中的子节点不重复参与。 */
function snapRectsOf(ids: readonly NodeId[]): Rect[] {
  return ids
    .filter((id) => {
      const n = docStore.doc.nodes[id];
      return Boolean(n) && (!n!.parentId || !ids.includes(n!.parentId));
    })
    .map((id) => worldRect(docStore.doc, id))
    .filter((r): r is Rect => Boolean(r));
}

/* ---------- 行内编辑（页面名 / 文本节点） ---------- */

function commitEditors() {
  if (textEdit.value) commitTextEdit();
  if (pageRename.value) commitPageRename();
}

function startPageRename(page: DocNode) {
  const r = pageLabelRect(page, vp, ctx);
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

function onDoubleClick(e: MouseEvent) {
  // 拖动模式只浏览：单击/双击都不改选区、不进编辑
  if (ui.mode === "pan") return;
  const rect = canvasRef.value!.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  // 锚点编辑态：双击锚点把两侧手柄归零（变尖角）
  if (pen.pathEdit) {
    const anchorHit = pathAnchorAt(pen, penDeps, vp, sx, sy);
    if (anchorHit && !anchorHit.side) {
      const node = docStore.doc.nodes[pen.pathEdit.id];
      if (node?.vector) {
        const anchors = node.vector.anchors.map((a, i) =>
          i === anchorHit.index ? { ...a, inX: 0, inY: 0, outX: 0, outY: 0 } : { ...a },
        );
        dispatch(
          {
            type: "node.update",
            params: { nodeId: pen.pathEdit.id, patch: { vector: { closed: node.vector.closed, anchors } } },
          },
          "path-corner",
        );
        pen.pathEdit.active = anchorHit.index;
        markDirty();
        return;
      }
    }
  }
  const label = ui.tool === "path" && pen.draft ? null : labelAt(sx, sy, vp, ctx);
  if (label) {
    if (label.id !== ui.activePageId) setActivePage(label.id, false);
    startPageRename(label);
    return;
  }
  if (ui.tool === "path") {
    finishDraft(pen, penDeps, false);
    return;
  }
  const w = screenToWorld(vp, sx, sy);
  const hit = hitTest(vp, w.x, w.y);
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
  if (node.type === "instance") {
    // 双击进入实例上下文；嵌套实例可继续逐级进入
    if (ui.instanceContext.at(-1) !== node.id) ui.instanceContext.push(node.id);
    select([node.id]);
    ui.expandedPageId = hit.pageId;
    markDirty();
    return;
  }
  if (node.type === "text") {
    startTextEdit(node);
    return;
  }
  if (node.type === "path" && node.vector) {
    // 双击路径进入锚点编辑：显示锚点、隐藏 8 个缩放手柄
    select([node.id]);
    pen.pathEdit = { id: node.id, active: 0 };
    ui.expandedPageId = hit.pageId;
    markDirty();
    return;
  }
  // 其它组件：双击 = 选中 + 检查器同步 + 左栏展开所在页面
  select([hit.id]);
  ui.expandedPageId = hit.pageId;
  markDirty();
}

/* 指针交互见下方 onPointerDown（含模式 / 手柄 / 活动页） */

/** 锚点编辑叠加层：把节点/原点/拖动预览换算好，交给绘制模块。 */
function paintPathEditing(g: CanvasRenderingContext2D): void {
  if (!pen.pathEdit) return;
  const node = docStore.doc.nodes[pen.pathEdit.id];
  const origin = worldRect(docStore.doc, pen.pathEdit.id);
  if (!node?.vector || !origin) return;
  const moving =
    drag && drag.mode === "move" && drag.moved && ui.selection.includes(pen.pathEdit.id)
      ? { dx: drag.offsetX, dy: drag.offsetY }
      : { dx: 0, dy: 0 };
  drawPathEditing(g, vp, {
    node,
    origin,
    active: pen.pathEdit.active,
    preview: pen.vectorDrag?.preview ?? null,
    move: moving,
  });
}

/** 空插槽占位：编辑模式的 UI 叠加层，不进入文档渲染。 */
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
  const hit = hitTest(vp, w.x, w.y);
  const node = hit && !hit.inactive ? docStore.doc.nodes[hit.id] : null;
  setHoverText(node?.type === "text" ? node.id : null);
  // 页面名称标签是编辑模式下移动整页的唯一入口，用 move 光标提示可拖
  const onLabel = Boolean(labelAt(sx, sy, vp, ctx));
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

const draftGuards = createDraftGuards(pen, () => canvasRef.value, () => finishDraft(pen, penDeps, false));

function onPointerLeave() {
  if (pen.draft) {
    pen.penHover = null;
    markDirty();
  }
  if (!drag) clearHover();
}

/** 根据手柄与指针位移计算新矩形（世界坐标；`keepAspect` 对应 Shift）。 */
function onPointerDown(e: PointerEvent) {
  commitEditors();
  clearHover();
  vectorPreview = null;
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

  // 0) 锚点编辑态：命中手柄/锚点则开始改形；点到别处则退出编辑
  if (pen.pathEdit) {
    const anchorHit = pathAnchorAt(pen, penDeps, vp, sx, sy);
    if (anchorHit) {
      const node = docStore.doc.nodes[pen.pathEdit.id];
      const origin = worldRect(docStore.doc, pen.pathEdit.id);
      if (node?.vector && origin) {
        pen.pathEdit.active = anchorHit.index;
        pen.vectorDrag = {
          pointerId: e.pointerId,
          kind: anchorHit.side ? "handle" : "anchor",
          index: anchorHit.index,
          side: anchorHit.side,
          startAnchors: node.vector.anchors.map((a) => ({ ...a, x: a.x + origin.x, y: a.y + origin.y })),
          startWX: w.x,
          startWY: w.y,
          moved: false,
          preview: null,
        };
        drag = { ...base, mode: "vector" };
        dragging.value = true;
        markDirty();
        return;
      }
    }
    const same = hitTest(vp, w.x, w.y);
    if (!same || same.id !== pen.pathEdit.id) {
      pen.pathEdit = null;
      markDirty();
    }
  }

  // 1) 缩放手柄（仅单选、非文本）
  const handleHit = hitHandle(sx, sy);
  if (handleHit) {
    const node = docStore.doc.nodes[handleHit.id];
    if (node) {
      const startRect = { x: node.x, y: node.y, width: node.width, height: node.height };
      resizePreview = { id: node.id, ...startRect };
      vectorPreview = null;
      drag = {
        ...base,
        startX: w.x,
        startY: w.y,
        mode: "resize",
        handle: handleHit.handle,
        resizeId: node.id,
        startRect,
        guide: guideContextFor([node.id]),
        startVector: node.vector
          ? { closed: node.vector.closed, anchors: node.vector.anchors.map((a) => ({ ...a })) }
          : undefined,
      };
      dragging.value = true;
      return;
    }
  }

  // 2) 页面名称标签：选中并开始移动整页——这是页面唯一的拖动入口
  //    钢笔草稿期间标签不再是拖动入口，否则画到页顶会误移动整页
  const label = ui.tool === "path" && pen.draft ? null : labelAt(sx, sy, vp, ctx);
  if (label) {
    if (label.id !== ui.activePageId) setActivePage(label.id, false);
    select([label.id]);
    ui.expandedPageId = label.id;
    drag = { ...base, startX: w.x, startY: w.y, mode: "move", guide: guideContextFor([label.id]), snapRects: snapRectsOf([label.id]) };
    markDirty();
    return;
  }

  // 3) 绘图工具：只允许在页面内起笔；落在非活动页先切换活动页
  if (ui.tool === "path") {
    if (e.button !== 0) return;
    const pageId = pageAt(w.x, w.y);
    // 跨到另一页点击：先收尾当前草稿，再用这次点击在新页起笔
    if (pen.draft && pageId && pageId !== pen.draft.pageId) finishDraft(pen, penDeps, false);
    if (!pen.draft) {
      if (!pageId) return;
      if (pageId !== ui.activePageId) setActivePage(pageId, false);
      beginDraft(pen, pageId, w.x, w.y);
      drag = { ...base, mode: "pen" };
      markDirty();
      return;
    }
    // 点回首锚闭合（≥3 个锚点）
    const first = pen.draft.anchors[0];
    const fp = worldToScreen(vp, first.x, first.y);
    if (pen.draft.anchors.length >= 3 && Math.hypot(fp.x - sx, fp.y - sy) <= 8) {
      finishDraft(pen, penDeps, true);
      return;
    }
    // ⇧ 约束到 45° 增量
    let px = w.x;
    let py = w.y;
    const last = pen.draft.anchors[pen.draft.anchors.length - 1];
    if (e.shiftKey && last) {
      const dx = px - last.x;
      const dy = py - last.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const step = Math.PI / 4;
        const angle = Math.round(Math.atan2(dy, dx) / step) * step;
        px = last.x + Math.cos(angle) * len;
        py = last.y + Math.sin(angle) * len;
      }
    }
    pen.draft.anchors.push(makeAnchor(px, py));
    pen.penHover = { x: px, y: py };
    drag = { ...base, mode: "pen" };
    markDirty();
    return;
  }

  const drawTool = drawToolOf(ui.tool);
  if (drawTool) {
    const pageId = pageAt(w.x, w.y);
    if (!pageId) return;
    if (pageId !== ui.activePageId) setActivePage(pageId, false);
    drag = { ...base, startX: w.x, startY: w.y, mode: "create", pageId, tool: drawTool };
    preview = { x: w.x, y: w.y, w: 0, h: 0, valid: true };
    return;
  }

  // 4) 选择
  const hit = hitTest(vp, w.x, w.y);
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
  // 在实例上下文里点了上下文之外的节点：先退出上下文
  if (ui.instanceContext.length) {
    let inside = false;
    let cur: DocNode | undefined = docStore.doc.nodes[hit.id];
    while (cur) {
      if (cur.id === ui.instanceContext.at(-1)) {
        inside = true;
        break;
      }
      cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
    }
    if (!inside) ui.instanceContext = [];
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
  // 自动布局容器里的普通子项：拖动 = 重排序；⌘ 拖动 = 转绝对定位
  const hitNode = docStore.doc.nodes[hit.id];
  const layoutParent = hitNode ? layoutParentOf(hitNode.id) : null;
  if (hitNode && layoutParent && !hitNode.layoutAbsolute && ui.selection.length === 1) {
    if (e.metaKey) {
      dispatch({ type: "node.update", params: { nodeId: hitNode.id, patch: { layoutAbsolute: true } } }, "layout");
    } else {
      dragging.value = true;
      drag = { ...base, startX: w.x, startY: w.y, mode: "reorder", reorderParentId: layoutParent.id, reorderIndex: -1 };
      markDirty();
      return;
    }
  }

  // 容器内参考线：同父兄弟 + 父内容区 + 父边界（页面拖动时父容器为空，候选是其它页面）
  const guide = guideContextFor(ui.selection);
  drag = { ...base, startX: w.x, startY: w.y, mode: "move", guide, snapRects: snapRectsOf(ui.selection) };
}

function onPointerMove(e: PointerEvent) {
  if (!drag) {
    if (pen.draft) {
      const rect = canvasRef.value!.getBoundingClientRect();
      pen.penHover = screenToWorld(vp, e.clientX - rect.left, e.clientY - rect.top);
      markDirty();
    } else {
      updateHover(e);
    }
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
    vectorPreview = null;
    preview = null;
    guideLines = [];
    gapMarks = [];
    dragging.value = false;
    return;
  } else if (drag.mode === "pen" && pen.draft) {
    if (!drag.moved) {
      if (Math.hypot(sx - drag.downX, sy - drag.downY) < 3) return;
      drag.moved = true;
    }
    const anchor = pen.draft.anchors[pen.draft.anchors.length - 1];
    if (!anchor) return;
    const dx = w.x - anchor.x;
    const dy = w.y - anchor.y;
    if (Math.hypot(dx, dy) < 1) return;
    anchor.outX = dx;
    anchor.outY = dy;
    if (e.altKey) {
      anchor.inX = 0;
      anchor.inY = 0;
    } else {
      anchor.inX = -dx;
      anchor.inY = -dy;
    }
    pen.penHover = null;
  } else if (drag.mode === "vector" && pen.vectorDrag) {
    if (!pen.vectorDrag.moved) {
      if (Math.hypot(sx - drag.downX, sy - drag.downY) < 3) return;
      pen.vectorDrag.moved = true;
    }
    const node = pen.pathEdit ? docStore.doc.nodes[pen.pathEdit.id] : null;
    if (!node?.vector) return;
    const vec: VectorPath = {
      closed: node.vector.closed,
      anchors: pen.vectorDrag.startAnchors.map((a) => ({ ...a })),
    };
    const index = Math.max(0, Math.min(pen.vectorDrag.index, vec.anchors.length - 1));
    if (pen.vectorDrag.kind === "anchor") {
      vec.anchors[index].x += w.x - pen.vectorDrag.startWX;
      vec.anchors[index].y += w.y - pen.vectorDrag.startWY;
    } else {
      const a = vec.anchors[index];
      const ox = w.x - a.x;
      const oy = w.y - a.y;
      const side = pen.vectorDrag.side ?? "out";
      if (side === "in") {
        a.inX = ox;
        a.inY = oy;
      } else {
        a.outX = ox;
        a.outY = oy;
      }
      // 默认镜像：对侧方向相反、长度保留；⌥ 断链时只动当前侧
      if (!e.altKey) {
        const otherLen = side === "in" ? Math.hypot(a.outX, a.outY) : Math.hypot(a.inX, a.inY);
        const len = Math.hypot(ox, oy);
        if (otherLen > 0 && len > 0) {
          if (side === "in") {
            a.outX = (-ox / len) * otherLen;
            a.outY = (-oy / len) * otherLen;
          } else {
            a.inX = (-ox / len) * otherLen;
            a.inY = (-oy / len) * otherLen;
          }
        }
      }
    }
    pen.vectorDrag.preview = vec;
  } else if (drag.mode === "reorder" && drag.reorderParentId) {
    if (!drag.moved) {
      if (Math.hypot(sx - drag.downX, sy - drag.downY) < 3) return;
      drag.moved = true;
    }
    drag.reorderIndex = reorderIndexAt(drag.reorderParentId, w.x, w.y, ui.selection);
    guideLines = reorderGuide(drag.reorderParentId, w.x, w.y);
  } else if (drag.mode === "move") {
    // 3px 阈值：双击/手抖不产生移动命令
    if (!drag.moved) {
      if (Math.hypot(sx - drag.downX, sy - drag.downY) < 3) return;
      drag.moved = true;
    }
    drag.offsetX = w.x - drag.startX;
    drag.offsetY = w.y - drag.startY;
    const slot = slotUnder(vp, w.x, w.y, ui.selection);
    if (drag.dropSlot !== slot) drag.dropSlot = slot;
    // ⌥ 临时关闭吸附：既不修正偏移，也不画线
    if (!e.altKey && drag.guide && drag.snapRects?.length) {
      const guides = computeGuides(drag.snapRects, drag.guide.targets, { dx: drag.offsetX, dy: drag.offsetY }, vp.zoom);
      drag.offsetX = guides.dx;
      drag.offsetY = guides.dy;
      guideLines = guides.lines;
      gapMarks = guides.gaps;
    } else {
      guideLines = [];
      gapMarks = [];
    }
  } else if (drag.mode === "resize") {
    if (!drag.resizeId || !drag.startRect || !drag.handle) return;
    if (!drag.moved) {
      if (Math.hypot(sx - drag.downX, sy - drag.downY) < 2) return;
      drag.moved = true;
    }
    const node = docStore.doc.nodes[drag.resizeId];
    const min = node?.type === "page" ? MIN_PAGE_SIZE : MIN_NODE_SIZE;
    const delta = localDelta(drag.resizeId, w.x - drag.startX, w.y - drag.startY);
    let next = resizeRect(drag.startRect, drag.handle, delta.dx, delta.dy, e.shiftKey, min);
    // 缩放参考线：只吸被拖动的边；⇧ 等比 / ⌥ 临时关闭时不吸附
    if (!e.altKey && !e.shiftKey && node && drag.guide) {
      const origin = worldRect(docStore.doc, node.id);
      const ox = origin ? origin.x - node.x : 0;
      const oy = origin ? origin.y - node.y : 0;
      const snapped = snapResizeRect(
        { x: ox + next.x, y: oy + next.y, width: next.width, height: next.height },
        drag.handle,
        drag.guide.targets,
        vp.zoom,
        min,
      );
      next = { x: snapped.rect.x - ox, y: snapped.rect.y - oy, width: snapped.rect.width, height: snapped.rect.height };
      guideLines = snapped.lines;
      gapMarks = snapped.gaps;
    } else {
      guideLines = [];
      gapMarks = [];
    }
    resizePreview = { id: drag.resizeId, ...next };
    if (drag.startVector && drag.startRect) {
      const sx = next.width / Math.max(1, drag.startRect.width);
      const sy = next.height / Math.max(1, drag.startRect.height);
      vectorPreview = { id: drag.resizeId, vector: scaleVector(drag.startVector, sx, sy) };
    }
  } else if (drag.mode === "create" && preview) {
    let pw = w.x - drag.startX;
    let ph = w.y - drag.startY;
    if (e.shiftKey && drag.tool === "triangle" && pw !== 0 && ph !== 0) {
      // 正三角形：宽高比 1 : √3/2，以拖动更长的方向为基准
      const sx = Math.sign(pw);
      const sy = Math.sign(ph);
      if (Math.abs(pw) >= Math.abs(ph)) ph = sy * Math.abs(pw) * EQUILATERAL_RATIO;
      else pw = sx * (Math.abs(ph) / EQUILATERAL_RATIO);
    }
    preview = { x: drag.startX, y: drag.startY, w: pw, h: ph, valid: Boolean(drag.pageId) };
    // 绘制参考线：只吸指针那一角，起点（锚）不动；⌥ 临时关闭
    const page = drag.pageId ? docStore.doc.nodes[drag.pageId] : null;
    if (!e.altKey && page) {
      const x0 = Math.min(preview.x, preview.x + preview.w);
      const y0 = Math.min(preview.y, preview.y + preview.h);
      const w0 = Math.abs(preview.w);
      const h0 = Math.abs(preview.h);
      const parent = containerAt(x0 + w0 / 2, y0 + h0 / 2) ?? page;
      const context = guideContextForParent(parent.id);
      const snapped = snapDrawRect(
        { x: x0, y: y0, width: w0, height: h0 },
        preview.w >= 0,
        preview.h >= 0,
        context.targets,
        vp.zoom,
      );
      const px = preview.w >= 0 ? snapped.rect.x + snapped.rect.width : snapped.rect.x;
      const py = preview.h >= 0 ? snapped.rect.y + snapped.rect.height : snapped.rect.y;
      preview = { ...preview, w: px - drag.startX, h: py - drag.startY };
      guideLines = snapped.lines;
      gapMarks = snapped.gaps;
    } else {
      guideLines = [];
      gapMarks = [];
    }
  }
  markDirty();
}

function onPointerUp() {
  if (!drag) return;
  dragging.value = false;
  // 只有编辑模式才提交移动/缩放；模式被切换过就整段丢弃（不产生命令、不留预览）
  if (drag.mode !== "pan" && ui.mode !== "edit") {
    resizePreview = null;
    vectorPreview = null;
    preview = null;
    drag = null;
    guideLines = [];
    gapMarks = [];
    markDirty();
    return;
  }
  if (drag.mode === "pen") {
    // 锚点已落在草稿里；松手只是结束手柄拖拽
    drag = null;
    markDirty();
    return;
  }
  if (drag.mode === "vector") {
    const edit = pen.pathEdit;
    const node = edit ? docStore.doc.nodes[edit.id] : null;
    const origin = edit ? worldRect(docStore.doc, edit.id) : null;
    if (pen.vectorDrag?.moved && pen.vectorDrag.preview && edit && node?.vector && origin) {
      const local = pen.vectorDrag.preview.anchors.map((a) => ({
        ...a,
        x: a.x - origin.x,
        y: a.y - origin.y,
      }));
      dispatch(
        {
          type: "node.update",
          params: { nodeId: edit.id, patch: { vector: { closed: pen.vectorDrag.preview.closed, anchors: local } } },
        },
        "path-edit",
      );
    }
    pen.vectorDrag = null;
    drag = null;
    markDirty();
    return;
  }
  if (drag.mode === "reorder") {
    if (drag.moved && drag.reorderParentId && (drag.reorderIndex ?? -1) >= 0) {
      const parentId = drag.reorderParentId;
      const index = drag.reorderIndex as number;
      const cmds = ui.selection.map((id) => ({
        type: "node.reparent" as const,
        params: { nodeId: id, parentId, index },
      }));
      dispatch(cmds, "reorder");
    }
    guideLines = [];
    gapMarks = [];
    drag = null;
    markDirty();
    return;
  }
  if (drag.mode === "resize") {
    if (drag.moved && resizePreview) {
      const node = docStore.doc.nodes[resizePreview.id];
      if (node) {
        const next: Partial<DocNode> = {
          x: Math.round(resizePreview.x),
          y: Math.round(resizePreview.y),
          width: Math.round(resizePreview.width),
          height: Math.round(resizePreview.height),
        };
        const parent = node.parentId ? docStore.doc.nodes[node.parentId] : null;
        if (parent?.layout && !node.layoutAbsolute) {
          next.layoutSizingW = "fixed";
          next.layoutSizingH = "fixed";
        }
        if (next.x !== node.x || next.y !== node.y || next.width !== node.width || next.height !== node.height) {
          try {
            dispatch({ type: "node.update", params: { nodeId: node.id, patch: next } }, "resize");
          } catch {
            /* 锁定或被核心拒绝时保持原状，不留下半成品预览 */
          }
        }
      }
    }
    resizePreview = null;
    vectorPreview = null;
    drag = null;
    markDirty();
    return;
  }
  if (drag.mode === "move" && drag.moved) {
    let filled = false;
    if (drag.dropSlot) {
      try {
        dispatch(
          {
            type: "slot.fill",
            params: { slotId: drag.dropSlot, nodeIds: [...ui.selection], dx: drag.offsetX, dy: drag.offsetY },
          },
          "slot-fill",
        );
        filled = true;
      } catch {
        filled = false;
      }
    }
    if (!filled && (drag.offsetX || drag.offsetY)) {
      const ids = [...ui.selection];
      const cmds = ids
        .filter((id) => docStore.doc.nodes[id] && !isLocked(id))
        .map((id) => {
          const n = docStore.doc.nodes[id];
          return { type: "node.update" as const, params: { nodeId: id, patch: { x: n.x + drag!.offsetX, y: n.y + drag!.offsetY } } };
        });
      if (cmds.length) dispatch(cmds, "move");
    }
  } else if (drag.mode === "create" && preview && drag.pageId && drag.tool) {
    try {
      const built = buildCreatedNode({ tool: drag.tool, pageId: drag.pageId, preview });
      dispatch(
        { type: "node.create", params: { nodes: [built.node], parentId: built.parentId, index: built.index } },
        "create",
      );
      ui.tool = "select";
      select([built.node.id]);
      const startEdit = built.startEdit;
      preview = null;
      drag = null;
      guideLines = [];
      gapMarks = [];
      markDirty();
      if (startEdit) startTextEdit(built.node, true);
      return;
    } catch {
      /* 起笔页面失效时按取消处理 */
    }
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
  if (e.type !== "keydown") return;

  // 草稿期间优先处理：撤销上一个锚点 / 结束路径（不触碰文档撤销栈）
  if (pen.draft) {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === "KeyZ") {
      e.preventDefault();
      e.stopImmediatePropagation();
      removeDraftAnchor(pen, penDeps);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopImmediatePropagation();
      removeDraftAnchor(pen, penDeps);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      finishDraft(pen, penDeps, false);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      finishDraft(pen, penDeps, false);
      return;
    }
  }

  if (e.key !== "Escape") return;

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
  if (pen.pathEdit) {
    pen.pathEdit = null;
    pen.vectorDrag = null;
    markDirty();
    return;
  }
  if (ui.instanceContext.length) {
    ui.instanceContext.pop();
    select(ui.instanceContext.length ? [ui.instanceContext.at(-1)!] : []);
    markDirty();
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
  if (pen.draft) finishDraft(pen, penDeps, false);
  pen.pathEdit = null;
  pen.vectorDrag = null;
  switchMode("edit");
  ui.tool = kind;
  clearHover();
}

let unsub = () => {};
let ro: ResizeObserver | null = null;
let stopModeWatch = () => {};
let stopSelectionWatch = () => {};
let stopShortcuts = () => {};

onMounted(() => {
  ctx = canvasRef.value!.getContext("2d");
  backend = new Canvas2DBackend(ctx!);
  hooks.getScreenshot = async () => {
    // 离屏重绘文档，不包含选中框、参考线、插槽占位等 UI 叠加层
    const off = document.createElement("canvas");
    const offCtx = off.getContext("2d");
    if (!offCtx) return "";
    const offBackend = new Canvas2DBackend(offCtx);
    offBackend.beginFrame(vp);
    drawDocument(offBackend, docStore.doc);
    offBackend.endFrame();
    return off.toDataURL("image/png");
  };
  hooks.focusNode = focusNode;
  hooks.focusPage = focusPage;
  hooks.getActivePageId = () => {
    if (ui.mode === "edit") return ensureActivePage()?.id ?? null;
    return pageAtViewportCenter()?.id ?? null;
  };
  hooks.insertInstance = insertInstance;
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
    "tool.triangle": () => pickTool("triangle"),
    "tool.line": () => pickTool("line"),
    "tool.path": () => pickTool("path"),
    "tool.text": () => pickTool("text"),
    "edit.undo": () => docStore.undo(),
    "edit.redo": () => docStore.redo(),
    "edit.delete": () => deleteSelectionAction(pen),
    "component.create": createComponentFromSelection,
    "component.detach": detachSelection,
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
      // 切换模式前先收尾钢笔草稿（按 Esc 规则），再丢弃其它进行中的手势
      if (pen.draft) finishDraft(pen, penDeps, false);
      pen.pathEdit = null;
      pen.vectorDrag = null;
      drag = null;
      preview = null;
      resizePreview = null;
      vectorPreview = null;
      guideLines = [];
      gapMarks = [];
      dragging.value = false;
      if (mode === "edit") {
        const page = ensureActivePage();
        // 现在编辑模式也能滚动了：只有活动页看不见（或几乎看不见）才强制适配
        if (page && visibleRatio(vp, page) < 0.15) fitActivePage();
      }
      markDirty();
    },
  );
  ro = new ResizeObserver(resize);
  ro.observe(canvasRef.value!.parentElement!);
  resize();
  raf = requestAnimationFrame(loop);
  stopSelectionWatch = watch(
    () => ui.selection,
    (selection) => {
      if (pen.pathEdit && !selection.includes(pen.pathEdit.id)) {
        pen.pathEdit = null;
        pen.vectorDrag = null;
        markDirty();
      }
    },
  );
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", draftGuards.onWindowPointerDown, true);
  window.addEventListener("blur", draftGuards.onWindowBlur);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  unsub();
  stopModeWatch();
  stopSelectionWatch();
  stopShortcuts();
  ro?.disconnect();
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("pointerdown", draftGuards.onWindowPointerDown, true);
  window.removeEventListener("blur", draftGuards.onWindowBlur);
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
    <div
      v-if="textEdit"
      ref="textEditEl"
      class="text-edit"
      :class="{ 'is-list': textEdit.listType !== 'none', 'is-numbered': textEdit.listType === 'numbered' }"
      contenteditable="true"
      spellcheck="false"
      v-html="textEdit.html"
      :style="{
        left: textEdit.left + 'px',
        top: textEdit.top + 'px',
        width: textEdit.width + 'px',
        height: textEdit.height + 'px',
        ...textEdit.css,
      }"
      @input="onTextEditInput"
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
  white-space: pre-wrap;
  overflow: hidden;
  outline: none;
}
.text-edit > div + div {
  margin-top: var(--para, 0px);
}
.text-edit.is-list > div {
  position: relative;
  padding-left: 1.2em;
}
.text-edit.is-numbered {
  counter-reset: text-li;
}
.text-edit.is-numbered > div::before {
  counter-increment: text-li;
  content: counter(text-li) ".";
  position: absolute;
  left: 0;
}
.text-edit.is-list:not(.is-numbered) > div::before {
  content: "•";
  position: absolute;
  left: 0.15em;
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
