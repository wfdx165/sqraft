<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  createNode,
  firstPageId,
  imageCropOf,
  makeAnchor,
  scaleVector,
  unionRects,
  worldRect,
  type Command,
  type DocNode,
  type NodeId,
  type Rect,
  type VectorPath,
} from "@sqraft/core";
import { Canvas2DBackend, drawDocument, screenToWorld, worldToScreen, type Viewport } from "@sqraft/render";
import { ensureAssetDecoded, imageFor } from "../assets";
import {
  dropImages,
  insertImages,
  pickImages as openImagePicker,
  readPickedFiles,
  viewportCenterWorld,
  type ImageInsertDeps,
} from "../canvas/image-actions";
import { abortCropDrag, applyCropDrag, beginCropDrag, endCropDrag } from "../canvas/crop-drag";
import { pasteNodesFromClipboard, type PasteDeps } from "../canvas/node-clipboard";
import { paintCropOverlay } from "../canvas/crop-overlay";
import { drawDraftPath, drawPathEditing, drawShapePreview } from "../canvas/vector-overlay";
import {
  beginDraft,
  createPenState,
  finishDraft,
  pathAnchorAt,
  removeDraftAnchor,
} from "../canvas/pen";
import { dispatch, docStore, hooks, select, switchMode, ui } from "../store";
import { closeContextMenu } from "../context-menu";
import { openNodeMenu, openPageMenu } from "../object-menu";
import { hitTest, isLocked, pageAt, slotUnder } from "../canvas/hit";
import { containerAt, layoutParentOf, reorderGuide, reorderIndexAt } from "../canvas/layout-drag";
import { dropAllowed, dropTargetAt, type DropTarget } from "../canvas/drop-target";
import { paintDropTarget } from "../canvas/drop-overlay";
import { hoverContainerAt } from "../canvas/child-outlines";
import {
  buildInsertPreview,
  isEmptyTransition,
  retargetInsertPreview,
  tickInsertPreview,
  type InsertTransition,
} from "../canvas/layout-preview";
import { buildCreatedNode } from "../canvas/create-drag";
import { deleteSelection as deleteSelectionAction } from "../canvas/delete-selection";
import { duplicateSelection } from "../canvas/duplicate-selection";
import { reorderSelection } from "../canvas/reorder-selection";
import { flushNudge, nudgeSelection } from "../canvas/nudge";
import { marqueeHits } from "../canvas/marquee";
import { boundsHandlePoints, selectionBounds as boundsOfSelection } from "../canvas/selection-bounds";
import { renderPngAsync } from "../canvas/export-image";
import { imageRefsOf } from "../canvas/image-assets";
import { ensureLinkedImage, linkedImage } from "../linked-images";
import { showToast } from "../toast";
import { RULER_SIZE, drawGuidesOverlay, drawRulers, guideAt } from "../canvas/rulers";
import {
  abortMultiScale,
  applyMultiScale,
  beginMultiScale,
  endMultiScale,
  type MultiScaleState,
} from "../canvas/multi-scale";
import { abortRotate, applyRotate, beginRotate, endRotate, rotateZoneAt, type RotateState } from "../canvas/rotate-drag";
import { groupSelection, ungroupSelection } from "../canvas/group-actions";
import { createDraftGuards } from "../canvas/draft-guard";
import { paintDropSlot as paintDrop, paintSlotPlaceholders as paintSlots } from "../canvas/slot-overlay";
import { drawRootLabels, rootLabelRect } from "../canvas/labels";
import {
  beginRootLabelDrag,
  beginRootLabelRename,
  rootLabelAtPointer,
  rootLabelHover,
  rootLabelMenuKind,
} from "../canvas/root-label-actions";
import {
  handlePointsOfQuad,
  localDelta,
  resizeRect,
  selectionQuad,
  type ResizeHandle,
} from "../canvas/selection";
import { drawPulse, drawSelectionOverlay } from "../canvas/selection-overlay";
import { agentActivity, agentFxActive, drawAgentOverlay } from "../canvas/agent-activity";
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
import { paintInfoOverlays } from "../canvas/info-overlays";
import { keyOf, registerShortcuts } from "../shortcuts";
import { vTip } from "../tooltip";
import { t } from "../i18n";
import Icon from "./Icon.vue";

/**
 * 三层画布（自下而上）：网格 → 文档 → UI 叠加层。
 * 文档层归渲染后端独占；指针事件与坐标换算都落在最上层的 UI 画布上。
 */
const gridCanvasRef = ref<HTMLCanvasElement | null>(null);
const docCanvasRef = ref<HTMLCanvasElement | null>(null);
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
/** 悬停的库对象（实例 / 主组件）：紫色虚线框，仅 UI 状态 */
const hoverLibraryId = ref<NodeId | null>(null);
/** 悬停的容器（画出其一级子元素边界，纯 UI 状态） */
const hoverContainerId = ref<NodeId | null>(null);

/** UI 叠加层上下文（唯一承接指针事件的画布） */
let ctx: CanvasRenderingContext2D | null = null;
/** 网格层上下文（视口辅助物，永远画在文档之下） */
let gridCtx: CanvasRenderingContext2D | null = null;
/** 文档层后端（独占中间那块画布） */
let backend: Canvas2DBackend | null = null;
let raf = 0;
let dirty = true;
/** 开发态帧耗时读数（生产构建不显示） */
const devHud = ref<string>("");
const DEV_HUD = import.meta.env.DEV;

let drag: {
  pointerId: number;
  mode: "pan" | "create" | "move" | "resize" | "multi-resize" | "rotate" | "pen" | "vector" | "crop";
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
  /** 参考线上下文（同父兄弟 + 父内容区 + 父边界；随落点父级切换） */
  guide?: GuideContext | null;
  /** 当前参考线上下文对应的父级（落点变化时重算） */
  guideKey?: NodeId | null;
  /** 参与吸附的移动根矩形（拖动开始时固定，世界坐标） */
  snapRects?: Rect[];
  /** 缩放手柄与起始矩形 */
  handle?: ResizeHandle;
  /** 拖动时指针下方的实例插槽（松手即填充，优先于换父级） */
  dropSlot?: NodeId | null;
  /** 换父级落点（指针下最深的画板/组件，或页面根） */
  drop?: DropTarget | null;
  /** 落点是否会真的改变父级（决定是否画落点高亮） */
  dropActive?: boolean;
  /** 落点是自动布局容器时的插入索引 */
  dropIndex?: number;
  /** 落点带自动布局（进流：只画插入线，不吸附） */
  dropLayout?: boolean;
  /** 最近一次指针屏幕坐标（自动滚屏时按同一位置重算世界坐标） */
  lastScreen?: { x: number; y: number };
  /** 最近一次指针事件的修饰键 */
  lastMods?: { alt: boolean; meta: boolean; shift: boolean };
  resizeId?: NodeId;
  startRect?: Rect;
  startAspect?: number;
  /** 缩放路径时的原始锚点（用于实时缩放预览） */
  startVector?: VectorPath;
  /** 起笔时的绘图工具：拖动中切工具也不会用新工具提交（避免造出非法节点） */
  tool?: DrawTool;
  /** 裁切拖拽：节点、起始裁切区域、手柄（null = 框内拖动） */
  cropId?: NodeId;
  cropHandle?: ResizeHandle | null;
  cropStart?: CropRect;
} | null = null;
let preview: { x: number; y: number; w: number; h: number; valid: boolean } | null = null;
/** 文档里是否已经有页面（空文件给引导卡，工具置灰） */
const hasPage = computed(() => {
  void ui.version;
  return docStore.doc.rootIds.some((id) => docStore.doc.nodes[id]?.type === "page");
});

/** 空文档：建第一个页面并适配视图 */
function createFirstPage(): void {
  const page = createNode("page", {
    name: `${t("node.page")} 1`,
    x: 0,
    y: 0,
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT,
  });
  dispatch({ type: "node.create", params: { nodes: [page], parentId: null } }, "新建页面");
  ui.activePageId = page.id;
  ui.expandedPageId = page.id;
  select([]);
  markDirty();
  void nextTick(() => fitView());
}

/** 多选缩放：拖拽中累积的比例（每次只下发增量） */
let multiScale: MultiScaleState | null = null;
/** 从标尺拖出参考线：axis = x 是竖线，y 是横线；world 是指针的世界坐标 */
let guideDrag: { axis: "x" | "y"; world: { x: number; y: number } } | null = null;
/** 视图开关（UI 偏好，跨文件跨启动保留） */
const guidesVisible = ref(localStorage.getItem("sqraft.guides.v1") !== "0");
const gridVisible = ref(localStorage.getItem("sqraft.grid.v1") !== "0");
const snapEnabled = ref(localStorage.getItem("sqraft.snap.v1") !== "0");

function toggleView(key: "guides" | "grid" | "snap"): void {
  const target = key === "guides" ? guidesVisible : key === "grid" ? gridVisible : snapEnabled;
  target.value = !target.value;
  localStorage.setItem(`sqraft.${key}.v1`, target.value ? "1" : "0");
  markDirty();
}
/** 旋转拖拽：中心与起始极角 */
let rotateState: RotateState | null = null;

/** 钢笔 / 锚点编辑的会话状态（纯 UI 状态）。 */
const pen = createPenState();
const viewportNav = createViewportNav({ vp, pen, markDirty, commitEditors });
const {
  flyTo,
  focusBounds,
  focusRect,
  focusNode,
  focusPage,
  activePage,
  pageAtViewportCenter,
  ensureActivePage,
  setActivePage,
  activatePage,
  fitAll,
  fitActivePage,
  fitView,
  visibleRatio,
} = viewportNav;
const componentActionDeps = { vp, ensureActivePage, markDirty };
const insertInstance = (id: NodeId) => insertInstanceAction(componentActionDeps, id);
const createComponentFromSelection = () => createComponentFromSelectionAction(componentActionDeps);
const detachSelection = () => detachSelectionAction(componentActionDeps);

const MIN_PAGE_SIZE = 200;
const MIN_NODE_SIZE = 8;
const HANDLE_HIT_PX = 7;
/** 拖动换父级时的边缘自动滚屏：触发区（屏幕像素）与最大速度（屏幕像素/秒） */
const EDGE_SCROLL_ZONE = 40;
const EDGE_SCROLL_MAX = 960;

/**
 * 切页会立刻改变视口：同一次双击的第二次按下在“同一位置 + 短时间”内出现时，
 * 不能再按旧屏幕坐标解释（否则会选中缩放后跑到指针下的其它节点）。
 * 用位置判断而不是 `pointerdown.detail`——Chromium 的 pointerdown detail 恒为 0。
 */
const REPEAT_CLICK_MS = 700;
const REPEAT_CLICK_PX = 4;
let pageSwitchClick: { x: number; y: number; at: number } | null = null;
/** 被吞掉的那一次按下不再触发 dblclick（文本编辑/裁切等） */
let suppressCanvasDblClickUntil = 0;

function notePageSwitchClick(sx: number, sy: number): void {
  const at = performance.now();
  pageSwitchClick = { x: sx, y: sy, at };
  suppressCanvasDblClickUntil = at + REPEAT_CLICK_MS;
}

function swallowRepeatClick(sx: number, sy: number): boolean {
  const first = pageSwitchClick;
  if (!first) return false;
  pageSwitchClick = null;
  if (performance.now() - first.at > REPEAT_CLICK_MS) return false;
  return Math.hypot(sx - first.x, sy - first.y) <= REPEAT_CLICK_PX;
}

/** 指针在画布内的最后位置（屏幕坐标）：粘贴节点的落点用它 */
let lastPointer: { x: number; y: number } | null = null;

/** 框选：屏幕坐标下的选框；超过 3px 才 active（否则松手 = 点击清空） */
let marquee: {
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  additive: boolean;
  base: NodeId[];
} | null = null;

/** 缩放中的实时预览（不改文档） */
let resizePreview: { id: NodeId; x: number; y: number; width: number; height: number } | null = null;
let vectorPreview: { id: NodeId; vector: VectorPath } | null = null;
const hoverHandle = ref<ResizeHandle | null>(null);
/** 指针在四角外侧的旋转热区里（光标换成旋转样式） */
const hoverRotate = ref(false);
const hoverInactive = ref(false);
const hoverLabel = ref(false);
const dragging = ref(false);
/** 插入图片用的隐藏文件选择器 */
const imageInput = ref<HTMLInputElement | null>(null);
/** 裁切拖拽期间挂起的事务：松手才落成一条撤销记录 */

/* 页面参考线（世界坐标，拖拽中计算，绘制时转屏幕） */
let guideLines: GuideLine[] = [];
let gapMarks: GapMark[] = [];

/* 布局插入的让位预览（120ms 过渡；拖动结束即清空） */
let insertPreview: InsertTransition | null = null;
let insertPreviewKey = "";

const cursor = computed(() =>
  cursorFor({
    mode: ui.mode,
    tool: ui.tool,
    dragging: dragging.value,
    hoverRotate: hoverRotate.value,
    hoverHandle: hoverHandle.value,
    hoverLabel: hoverLabel.value,
    hoverText: Boolean(hoverTextId.value),
    hoverInactive: hoverInactive.value,
  }),
);

function markDirty() {
  dirty = true;
}

/** 叠加层画布尺寸跟随视口与 DPR（文档层由后端在 beginFrame 里自行处理）。 */
function syncLayerSize(canvas: HTMLCanvasElement): void {
  const w = Math.round(vp.width * vp.dpr);
  const h = Math.round(vp.height * vp.dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

/** 按设备像素清空整层（与当前变换无关）。 */
function clearLayer(g: CanvasRenderingContext2D): void {
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  g.restore();
}

/** 钢笔逻辑的依赖：文档、UI 状态与命令入口（显式注入，模块内不 import 单例）。 */
const penDeps = { docStore, ui, dispatch, select, markDirty };

function draw() {
  if (!ctx || !backend) return;
  const frameStarted = DEV_HUD ? performance.now() : 0;

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

  // 非活动页淡化（编辑模式）；主组件是根节点、不属于任何页面，不参与淡化
  const dimPageIds = editing
    ? docStore.doc.rootIds.filter((id) => id !== ui.activePageId && docStore.doc.nodes[id]?.type === "page")
    : undefined;

  // 网格层：视口辅助物，独立画布，永远在文档之下
  if (gridCtx) {
    syncLayerSize(gridCtx.canvas);
    clearLayer(gridCtx);
    if (gridVisible.value) drawGrid(gridCtx, vp);
  }

  backend.beginFrame(vp);
  drawDocument(backend, docStore.doc, {
    hideTextId: textEdit.value?.id,
    hidePathId: pen.vectorDrag?.preview && pen.pathEdit ? pen.pathEdit.id : undefined,
    movePreview,
    resizePreview: editing ? (resizePreview ?? undefined) : undefined,
    vectorPreview: editing ? (vectorPreview ?? undefined) : undefined,
    geometryPreview: insertPreview?.boxes,
    dimPageIds,
    resolveImage: (assetId) => imageFor(assetId),
    resolveLinkedImage: (url) => linkedImage(url),
  });
  backend.endFrame();

  // 覆盖层（UI 层）：独立画布，永远在文档之上；每帧自行清屏
  syncLayerSize(ctx.canvas);
  ctx.save();
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  ctx.clearRect(0, 0, vp.width, vp.height);

  // 只读信息层：悬停容器子元素边界、选中量距、多选整体虚线框
  // 框选与拖标尺参考线也属于手势（不写 drag），统一按 busy 收口
  const busyGesture =
    Boolean(drag) || Boolean(marquee) || Boolean(guideDrag) ||
    Boolean(pen.pathEdit) || Boolean(pen.draft) || Boolean(ui.cropNodeId) || Boolean(textEdit.value);
  paintInfoOverlays(ctx, vp, {
    editing,
    tool: ui.tool,
    busy: busyGesture,
    doc: docStore.doc,
    selection: ui.selection,
    hoverContainerId: hoverContainerId.value,
    multiBounds: editing && ui.selection.length > 1 && !drag ? selectionWorldBounds() : null,
  });

  drawSelectionOverlay(ctx, vp, {
    selection: ui.selection,
    editing,
    drag,
    resizePreview,
    textEditId: textEdit.value?.id ?? null,
    pathEditId: pen.pathEdit?.id ?? null,
    hoverTextId: hoverTextId.value,
    hoverLibraryId: hoverLibraryId.value,
  });

  const activePageNode = ui.activePageId ? docStore.doc.nodes[ui.activePageId] : null;
  if (editing) {
    drawRulers(ctx, vp, activePageNode ?? null, selectionWorldBounds());
    if (guidesVisible.value) {
      const preview = guideDrag
        ? { axis: guideDrag.axis, world: guideDrag.axis === "x" ? guideDrag.world.x : guideDrag.world.y }
        : null;
      drawGuidesOverlay(ctx, vp, activePageNode ?? null, preview);
    }
  }

  if (marquee?.active) {
    const x = Math.min(marquee.startX, marquee.x);
    const y = Math.min(marquee.startY, marquee.y);
    const w = Math.abs(marquee.x - marquee.startX);
    const h = Math.abs(marquee.y - marquee.startY);
    ctx.fillStyle = "rgba(79, 70, 229, 0.08)";
    ctx.strokeStyle = "rgba(79, 70, 229, 0.55)";
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  }

  paintPathEditing(ctx);
  paintCropOverlay(ctx, vp, docStore.doc, ui.cropNodeId);
  drawDraftPath(ctx, vp, pen.draft, pen.penHover);
  paintGuides(ctx, vp, guideLines, gapMarks);
  paintSlots(ctx, vp, ui.activePageId, ui.mode);

  if (preview) drawShapePreview(ctx, vp, preview, drag?.tool ?? ui.tool);
  paintDrop(ctx, vp, drag?.dropSlot ?? null);
  paintDropTarget(ctx, vp, drag?.dropActive ? (drag.drop ?? null) : null);

  const pulse = viewportNav.nav.pulse;
  if (pulse) {
    const n = docStore.doc.nodes[pulse.id];
    const t = (performance.now() - pulse.start) / PULSE_MS;
    if (!n || t >= 1) viewportNav.nav.pulse = null;
    else drawPulse(ctx, vp, pulse.id, t);
  }

  // agent 改动标注：文档层之上、选中框之外，短时非阻挡
  drawAgentOverlay(ctx, vp);

  ctx.restore();
  drawRootLabels(ctx, vp, {
    renameId: pageRename.value?.id ?? null,
    drag,
    resizePreview,
    selection: ui.selection,
    activePageId: ui.activePageId,
    mode: ui.mode,
  });

  if (DEV_HUD) {
    const total = performance.now() - frameStarted;
    devHud.value = `${total.toFixed(1)}ms · 离屏 ${backend.stats.layers} (${backend.stats.layerMs.toFixed(1)}ms)`;
  }
}

let lastTick = performance.now();
/** 呼吸描边不需要 60fps：限到 30fps，长调用时别为了一点呼吸把整层文档重绘满帧 */
const AGENT_FX_FPS = 30;
let lastAgentPaint = 0;

function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;
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
  // 拖动换父级：指针停在视口边缘时连续滚屏，并按同一屏幕坐标重算落点与参考线
  autoScrollStep(dt);
  // 布局让位：120ms 缓动，过渡期间持续重绘
  if (insertPreview) {
    const tick = tickInsertPreview(insertPreview, now);
    insertPreview.boxes = tick.boxes;
    dirty = true;
    if (tick.done && isEmptyTransition(insertPreview)) insertPreview = null;
  }
  const pulse = viewportNav.nav.pulse;
  const agentFrame = agentFxActive(now, vp) && now - lastAgentPaint >= 1000 / AGENT_FX_FPS;
  if (dirty || (pulse && now - pulse.start < PULSE_MS) || agentFrame) {
    if (agentFrame) lastAgentPaint = now;
    dirty = false;
    draw();
  }
  raf = requestAnimationFrame(loop);
}

/** 边缘变速滚屏：速度按离边距离平方衰减，靠近边缘越快。 */
function autoScrollStep(dt: number): boolean {
  const d = drag;
  if (!d || d.mode !== "move" || !d.moved || !d.lastScreen || !canvasRef.value) return false;
  const rect = canvasRef.value.getBoundingClientRect();
  const { x, y } = d.lastScreen;
  // 指针已经离开画布（指针捕获期间）：不滚
  if (x < -2 || y < -2 || x > rect.width + 2 || y > rect.height + 2) return false;
  const speed = (dist: number) => {
    if (dist >= EDGE_SCROLL_ZONE) return 0;
    const t = (EDGE_SCROLL_ZONE - Math.max(0, dist)) / EDGE_SCROLL_ZONE;
    return EDGE_SCROLL_MAX * t * t;
  };
  const vx = speed(x) - speed(rect.width - x);
  const vy = speed(y) - speed(rect.height - y);
  if (!vx && !vy) return false;
  vp.x += (vx * dt) / vp.zoom;
  vp.y += (vy * dt) / vp.zoom;
  updateMoveDrag();
  return true;
}

/** 窗口尺寸变化的防抖计时器：拖动边框时不跟着抖，停手再适配 */
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

const resize = () => {
  viewportNav.resize(canvasRef.value);
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    // 只有视角还停在适配结果上才重新适配；手动缩放过就保持原样（别抢用户视角）
    if (viewportNav.isFitted()) fitView();
  }, 120);
};

/** 选区包围盒（世界坐标，忽略旋转）：多选手柄与检查器共用同一份实现 */
function selectionWorldBounds(): Rect | null {
  return boundsOfSelection(docStore.doc, ui.selection);
}

function hitHandle(sx: number, sy: number): { handle: ResizeHandle; id: NodeId } | null {
  if (pen.pathEdit) return null;
  if (ui.mode !== "edit" || ui.tool !== "select" || ui.selection.length === 0) return null;
  // 多选：手柄围绕选区包围盒；id 为空串表示"整组缩放"
  if (ui.selection.length > 1) {
    // 选区里有锁定节点：不出手柄（core 会跳过它们，但手柄会把整组当成可缩放）
    if (ui.selection.some((id) => isLocked(id))) return null;
    const bounds = selectionWorldBounds();
    if (!bounds) return null;
    const tl = worldToScreen(vp, bounds.x, bounds.y);
    const br = worldToScreen(vp, bounds.x + bounds.width, bounds.y + bounds.height);
    for (const [handle, hx, hy] of boundsHandlePoints(tl, br)) {
      if (Math.abs(sx - hx) <= HANDLE_HIT_PX && Math.abs(sy - hy) <= HANDLE_HIT_PX) return { handle, id: "" };
    }
    return null;
  }
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

/**
 * 旋转热区的四个角（屏幕坐标）：多选用选区包围盒，单选用随节点旋转的四边形。
 * 只给"编辑模式 + 选择工具 + 有选区且无锁定节点"的情况返回角点。
 */
function rotateZoneCorners(): { x: number; y: number }[] | null {
  if (pen.pathEdit) return null;
  if (ui.mode !== "edit" || ui.tool !== "select" || ui.selection.length === 0) return null;
  // 选区含锁定节点时不给旋转入口：core 会跳过它们，手势看起来像失效
  if (ui.selection.some((id) => isLocked(id))) return null;
  if (ui.selection.length > 1) {
    const bounds = selectionWorldBounds();
    if (!bounds) return null;
    const tl = worldToScreen(vp, bounds.x, bounds.y);
    const br = worldToScreen(vp, bounds.x + bounds.width, bounds.y + bounds.height);
    return [tl, { x: br.x, y: tl.y }, br, { x: tl.x, y: br.y }];
  }
  return selectionQuad(vp, ui.selection[0], resizePreview, drag);
}

/** 四角外侧 12px 的旋转热区；手柄本体（±HANDLE_HIT_PX）仍归缩放。 */
function hitRotateZone(sx: number, sy: number): boolean {
  const corners = rotateZoneCorners();
  return corners ? rotateZoneAt(corners, sx, sy, HANDLE_HIT_PX) : false;
}

/** 参与移动的根节点：父节点也被选中的子节点不重复参与。 */
function movingRootIds(ids: readonly NodeId[]): NodeId[] {
  return ids.filter((id) => {
    const n = docStore.doc.nodes[id];
    return Boolean(n) && (!n!.parentId || !ids.includes(n!.parentId));
  });
}

/** 参与吸附的移动根矩形：父节点也被选中的子节点不重复参与。 */
function snapRectsOf(ids: readonly NodeId[]): Rect[] {
  return movingRootIds(ids)
    .map((id) => worldRect(docStore.doc, id))
    .filter((r): r is Rect => Boolean(r));
}

/* ---------- 行内编辑（页面名 / 文本节点） ---------- */

function commitEditors() {
  if (textEdit.value) commitTextEdit();
  if (pageRename.value) commitPageRename();
}

/** 根节点名称标签的改名入口：页面与主组件共用（输入框浮在标签上）。 */
function startLabelRename(node: DocNode) {
  const r = rootLabelRect(node, vp, ctx);
  if (!r) {
    // 标签被视口夹掉了（对象整块在视口上方）：退回"图层左上角"的旧定位
    select([node.id]);
    startRenameForSelection();
    return;
  }
  pageRename.value = { id: node.id, value: node.name, left: r.x, top: r.y, width: Math.max(r.width, 96) };
  markDirty();
  void nextTick(() => {
    renameEl.value?.focus();
    renameEl.value?.select();
  });
}

/** 参考线写进页面（页面本地坐标；1px 内视为同一条） */
function commitGuide(axis: "x" | "y", world: { x: number; y: number }): void {
  // 指针在哪个页面就落到哪个页面，取不到才回落活动页
  const pageId = pageAt(world.x, world.y) ?? ui.activePageId;
  const page = pageId ? docStore.doc.nodes[pageId] : null;
  if (!page || page.type !== "page") return;
  const current = page.guides ?? { x: [], y: [] };
  const local = axis === "x" ? world.x - page.x : world.y - page.y;
  const list = axis === "x" ? [...current.x] : [...current.y];
  if (list.some((value) => Math.abs(value - local) <= 1)) return;
  list.push(Math.round(local * 10) / 10);
  dispatch(
    {
      type: "node.update",
      params: { nodeId: page.id, patch: { guides: axis === "x" ? { ...current, x: list } : { ...current, y: list } } },
    },
    "参考线",
  );
}

function removeGuide(axis: "x" | "y", index: number): void {
  const page = ui.activePageId ? docStore.doc.nodes[ui.activePageId] : null;
  if (!page?.guides) return;
  const next = {
    x: axis === "x" ? page.guides.x.filter((_, i) => i !== index) : [...page.guides.x],
    y: axis === "y" ? page.guides.y.filter((_, i) => i !== index) : [...page.guides.y],
  };
  dispatch({ type: "node.update", params: { nodeId: page.id, patch: { guides: next } } }, "删除参考线");
}

/** 框选命中：当前层级、可见、未锁定，包围盒相交即选 */
function updateMarqueeSelection(): void {
  if (!marquee) return;
  const a = screenToWorld(vp, marquee.startX, marquee.startY);
  const b = screenToWorld(vp, marquee.x, marquee.y);
  const rect = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
  const levelId = ui.instanceContext.length ? ui.instanceContext.at(-1)! : ui.activePageId;
  const hits = marqueeHits(docStore.doc, levelId, rect);
  select(marquee.additive ? [...new Set([...marquee.base, ...hits])] : hits);
}

/** F2：重命名选中图层（输入框浮在图层左上角，和页面改名同一套提交逻辑） */
function startRenameForSelection(): void {
  const id = ui.selection[0];
  const node = id ? docStore.doc.nodes[id] : null;
  if (!node || node.type === "page") return;
  const rect = worldRect(docStore.doc, node.id);
  if (!rect) return;
  const screen = worldToScreen(vp, rect.x, rect.y);
  pageRename.value = {
    id: node.id,
    value: node.name,
    left: screen.x,
    top: Math.max(0, screen.y - 26),
    width: Math.max(120, rect.width * vp.zoom),
  };
  markDirty();
  void nextTick(() => {
    renameEl.value?.focus();
    renameEl.value?.select();
  });
}

/** ⌘⇧C：把选区（无选区则活动页）复制成 PNG 到剪贴板 */
async function copySelectionAsPng(): Promise<void> {
  const pageId = ensureActivePage()?.id ?? null;
  if (!pageId) {
    showToast(t("canvas.copyNoPage"), "error");
    return;
  }
  const ids = ui.selection.filter((id) => {
    const node = docStore.doc.nodes[id];
    return !!node && node.type !== "page";
  });
  // 字体可能还在加载：导出前等一次，避免落成回退字体
  try {
    await document.fonts.ready;
    const dataUrl = await renderPngAsync(docStore.doc, {
      pageId,
      nodeIds: ids.length > 0 ? ids : undefined,
      scale: 2,
      resolveImage: (assetId) => imageFor(assetId),
      resolveLinkedImage: (url) => linkedImage(url),
      ensureImage: ensureAssetDecoded,
      ensureLinkedImage,
    });
    if (!dataUrl) {
      showToast(t("canvas.copyEmpty"), "error");
      return;
    }
    const ok = await window.sqraft.app.writeClipboardImage(dataUrl);
    showToast(ok ? t("canvas.copiedPng") : t("canvas.copyClipboardUnavailable"), ok ? "info" : "error");
  } catch (error) {
    showToast(t("canvas.copyFailed", { detail: String(error) }), "error");
  }
}

/** ⌘A：全选当前层级的可见未锁定图层（实例上下文内只选当前层） */
function selectAllInPage(): void {
  const level = ui.instanceContext.length ? ui.instanceContext.at(-1)! : ensureActivePage()?.id;
  const container = level ? docStore.doc.nodes[level] : null;
  if (!container) return;
  select(container.children.filter((id) => {
    const node = docStore.doc.nodes[id];
    return !!node && node.visible && !isLocked(id);
  }));
  markDirty();
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

/** 右键：页面本体 → 页面菜单，元素 → 元素菜单；空白处不弹（先点一下对象）。 */
function onContextMenu(e: MouseEvent): void {
  // 行内文本编辑 / 改名输入框：保留系统菜单（复制、粘贴）
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
  e.preventDefault();
  if (!canvasRef.value) return;
  commitEditors();
  const rect = canvasRef.value.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const position = { x: e.clientX, y: e.clientY };
  // 标题画在节点矩形之外，hitTest 打不到：按标签命中补一条，右键标题同样弹菜单
  const label = rootLabelAtPointer(vp, ctx, sx, sy, Boolean(pen.draft));
  if (label) {
    if (rootLabelMenuKind(label) === "page") openPageMenu(label.id, position);
    else openNodeMenu(label.id, position);
    return;
  }
  const world = screenToWorld(vp, sx, sy);
  const hit = hitTest(vp, world.x, world.y);
  if (!hit) {
    closeContextMenu();
    return;
  }
  if (hit.id === hit.pageId || hit.inactive) openPageMenu(hit.pageId, position);
  else openNodeMenu(hit.id, position);
}

function onDoubleClick(e: MouseEvent) {
  if (performance.now() < suppressCanvasDblClickUntil) return;
  const guideRect = canvasRef.value?.getBoundingClientRect();
  if (guideRect && guidesVisible.value) {
    const pageNode = ui.activePageId ? docStore.doc.nodes[ui.activePageId] ?? null : null;
    const hit = guideAt(vp, pageNode, e.clientX - guideRect.left, e.clientY - guideRect.top);
    if (hit) {
      removeGuide(hit.axis, hit.index);
      return;
    }
  }
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
  // 双击根节点标签 = 行内改名（页面与母版同一套；母版不进页面切换）
  const label = rootLabelAtPointer(vp, ctx, sx, sy, Boolean(pen.draft));
  if (label) {
    beginRootLabelRename(label, {
      setActivePage: (id) => setActivePage(id, false),
      startRename: startLabelRename,
    });
    return;
  }
  if (ui.tool === "path") {
    finishDraft(pen, penDeps, false);
    return;
  }
  const w = screenToWorld(vp, sx, sy);
  const hit = hitTest(vp, w.x, w.y);
  if (!hit) {
    marquee = { startX: sx, startY: sy, x: sx, y: sy, active: false, additive: e.shiftKey, base: [...ui.selection] };
    dragging.value = true;
    return;
  }
  if (hit.inactive) {
    // 点另一页 = 切页 + 适配该页（与左栏页面行一致）
    activatePage(hit.pageId);
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
  if (node.type === "image") {
    // 双击图片进入裁切：框内拖动定位、手柄缩放裁切范围
    select([node.id]);
    ui.cropNodeId = node.id;
    ui.expandedPageId = hit.pageId;
    markDirty();
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

function setHoverLibrary(id: NodeId | null) {
  if (hoverLibraryId.value === id) return;
  hoverLibraryId.value = id;
  markDirty();
}

function clearHover() {
  setHoverText(null);
  setHoverLibrary(null);
  if (hoverContainerId.value) {
    hoverContainerId.value = null;
    markDirty();
  }
  if (hoverHandle.value) {
    hoverHandle.value = null;
    markDirty();
  }
  if (hoverRotate.value) {
    hoverRotate.value = false;
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
  // 旋转热区只在没有缩放手柄时提示，避免两个光标来回跳
  const rotate = !handle && hitRotateZone(sx, sy);
  if (hoverRotate.value !== rotate) {
    hoverRotate.value = rotate;
    markDirty();
  }
  const w = screenToWorld(vp, sx, sy);
  const hit = hitTest(vp, w.x, w.y);
  const node = hit && !hit.inactive ? docStore.doc.nodes[hit.id] : null;
  setHoverText(node?.type === "text" ? node.id : null);
  // 根节点名称标签：用 move 光标提示可拖；悬停母版标签时连它的紫色悬停框一起点亮
  const label = rootLabelAtPointer(vp, ctx, sx, sy, Boolean(pen.draft));
  const hover = rootLabelHover(label, node);
  // 库对象（实例 / 主组件）单独一套悬停框；进入实例后命中的是子节点，自然跟着走
  setHoverLibrary(hover.libraryId);
  // 悬停容器的子元素边界（只读信息层）
  const containerId = hit && !hit.inactive ? hoverContainerAt(w.x, w.y) : null;
  if (hoverContainerId.value !== containerId) {
    hoverContainerId.value = containerId;
    markDirty();
  }
  if (hoverLabel.value !== hover.onLabel) {
    hoverLabel.value = hover.onLabel;
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
  lastPointer = null;
  if (pen.draft) {
    pen.penHover = null;
    markDirty();
  }
  if (!drag) clearHover();
}

/** 放弃当前手势（Esc）：清掉预览与参考线，不产生任何命令。 */
/**
 * 窗口失焦时松手事件收不到：把所有"开了事务的手势"收尾，避免事务永久挂起
 * （挂起的事务会让之后每次编辑都并进去，撤销栈不再增长）。
 * 失焦按"结束手势"处理（提交），取消由 Esc 负责。
 */
function onWindowBlurEndGesture(): void {
  marquee = null;
  if (!drag) {
    dragging.value = false;
    return;
  }
  if (drag.mode === "crop") endCropDrag();
  if (drag.mode === "rotate") {
    endRotate();
    rotateState = null;
  }
  if (drag.mode === "multi-resize") {
    endMultiScale();
    multiScale = null;
  }
  drag = null;
  dragging.value = false;
  markDirty();
}

function cancelDrag() {
  if (!drag) return;
  if (drag.mode === "crop") {
    // 手势取消 = 回到拖拽前，且**不留撤销记录**
    abortCropDrag();
  }
  if (drag.mode === "rotate") {
    // 取消 = 回到拖拽前，且不留撤销记录（与裁切取消同一套）
    abortRotate();
    rotateState = null;
  }
  if (drag.mode === "multi-resize") {
    abortMultiScale();
    multiScale = null;
  }
  dragging.value = false;
  drag = null;
  resizePreview = null;
  vectorPreview = null;
  preview = null;
  guideLines = [];
  gapMarks = [];
  clearInsertPreview();
  markDirty();
}

/** 清空布局让位预览（拖动结束 / 取消 / 切模式）。 */
function clearInsertPreview() {
  if (!insertPreview && !insertPreviewKey) return;
  insertPreview = null;
  insertPreviewKey = "";
  markDirty();
}

/** 根据手柄与指针位移计算新矩形（世界坐标；`keepAspect` 对应 Shift）。 */

/* ---------------- 图片：插入 / 粘贴 / 拖入 ---------------- */

/**
 * 图片插入需要的画布能力：取页面、坐标换算、切活动页。
 * 具体流程在 `canvas/image-actions.ts`，画布只负责接线。
 */
const imageDeps: ImageInsertDeps = {
  viewport: () => vp,
  screenToWorld: (x, y) => screenToWorld(vp, x, y),
  activePage,
  pageAtViewportCenter,
  pageAt,
  focusPage: (pageId) => {
    if (ui.mode === "edit" && ui.activePageId !== pageId) setActivePage(pageId, false);
    ui.expandedPageId = pageId;
  },
};

/** 粘贴落点：指针在画布上就粘到指针处，父级取指针下的容器 */
const pasteDeps: PasteDeps = {
  pointerWorld: () => (lastPointer ? screenToWorld(vp, lastPointer.x, lastPointer.y) : null),
  activePageId: () => activePage()?.id ?? null,
  pageAt,
  containerAt: (x, y) => containerAt(x, y),
};

const onCanvasDrop = (e: DragEvent) => dropImages(e, imageDeps, canvasRef.value);
const onImagePicked = (e: Event) => readPickedFiles(e, imageDeps);

/* ---------------- 图片裁切 ---------------- */

/** 进入/退出裁切模式：只改 UI 状态，文档在拖动时才变。 */
function toggleCrop(nodeId: NodeId | null): void {
  ui.cropNodeId = ui.cropNodeId === nodeId ? null : nodeId;
  ui.selection = nodeId ? [nodeId] : ui.selection;
  markDirty();
}


function onPointerDown(e: PointerEvent) {
  // 切页后同一次双击的第二下：位置不变但视口已经变了，旧坐标失效，直接吞掉
  const downRect = canvasRef.value?.getBoundingClientRect();
  if (downRect && swallowRepeatClick(e.clientX - downRect.left, e.clientY - downRect.top)) return;
  // 先收掉微移会话，避免这次点击的命令被并进"微移"那条撤销
  flushNudge();
  commitEditors();
  clearHover();
  clearInsertPreview();
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

  // 标尺区按下：拖出参考线（横线来自顶部标尺，竖线来自左侧标尺）
  if (e.button === 0 && ui.mode === "edit" && (sx < RULER_SIZE || sy < RULER_SIZE)) {
    guideDrag = { axis: sy < RULER_SIZE ? "y" : "x", world: { x: w.x, y: w.y } };
    dragging.value = true;
    markDirty();
    return;
  }

  // 拖动模式：任意处拖动都是平移（包括页面与图层上方）
  if (ui.mode === "pan") {
    if (e.button !== 0 && e.button !== 1) return;
    drag = { ...base, mode: "pan" };
    dragging.value = true;
    return;
  }

  // 编辑模式：中键不再平移（视图操作属于拖动模式）
  if (e.button === 1) return;

  // 裁切模式：图内拖动 = 移动裁切窗口，抓手柄 = 缩放裁切范围，点图外 = 退出
  if (ui.cropNodeId) {
    const cropId = ui.cropNodeId;
    const node = docStore.doc.nodes[cropId];
    if (!node?.image) {
      ui.cropNodeId = null;
    } else {
      const hit = hitTest(vp, w.x, w.y);
      if (hit?.id === cropId) {
        const handleHit = hitHandle(sx, sy);
        drag = { ...base, ...beginCropDrag(node, w, handleHit?.id === cropId ? handleHit.handle : null) };
        return;
      }
      ui.cropNodeId = null;
      markDirty();
    }
  }

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

  // 0.5) 根节点名称标签（页面 / 主组件）：选中并开始移动——这是整页与整块母版唯一的拖动入口。
  //      放在旋转热区与缩放手柄之前：标签是刻意的目标，左上角不该被热区抢走。
  const label = rootLabelAtPointer(vp, ctx, sx, sy, Boolean(pen.draft));
  if (label) {
    beginRootLabelDrag(label, { setActivePage: (id) => setActivePage(id, false) });
    drag = {
      ...base,
      startX: w.x,
      startY: w.y,
      mode: "move",
      guide: guideContextFor([label.id]),
      guideKey: null,
      snapRects: snapRectsOf([label.id]),
    };
    markDirty();
    return;
  }

  // 1) 四角外侧的旋转热区（手柄本体不落在这里，优先给缩放）
  if (hitRotateZone(sx, sy)) {
    const bounds = selectionWorldBounds();
    if (bounds) {
      rotateState = beginRotate({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, w);
      drag = { ...base, startX: w.x, startY: w.y, mode: "rotate" };
      dragging.value = true;
      return;
    }
  }

  // 2) 缩放手柄（仅单选、非文本；多选是整组等比缩放）
  const handleHit = hitHandle(sx, sy);
  if (handleHit && !handleHit.id) {
    const bounds = selectionWorldBounds();
    if (bounds) {
      multiScale = beginMultiScale(bounds, handleHit.handle);
      drag = { ...base, startX: w.x, startY: w.y, mode: "multi-resize", handle: handleHit.handle, startRect: bounds };
      dragging.value = true;
      return;
    }
  }
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

  // 4) 绘图工具：只允许在页面内起笔；落在非活动页先切换活动页
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

  // 5) 选择
  const hit = hitTest(vp, w.x, w.y);
  if (!hit) {
    marquee = { startX: sx, startY: sy, x: sx, y: sy, active: false, additive: e.shiftKey, base: [...ui.selection] };
    dragging.value = true;
    return;
  }
  if (hit.inactive) {
    // 点另一页 = 切页 + 适配该页；不顺势拖动，避免误移整页
    activatePage(hit.pageId);
    notePageSwitchClick(sx, sy);
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
  // 自动布局容器里的普通子项：⌘ 按下时先转绝对定位，再当作普通拖动（换父级统一走 move）
  const hitNode = docStore.doc.nodes[hit.id];
  const layoutParent = hitNode ? layoutParentOf(hitNode.id) : null;
  if (hitNode && layoutParent && !hitNode.layoutAbsolute && ui.selection.length === 1 && e.metaKey) {
    dispatch({ type: "node.update", params: { nodeId: hitNode.id, patch: { layoutAbsolute: true } } }, "layout");
  }

  // 容器内参考线：同父兄弟 + 父内容区 + 父边界（页面拖动时父容器为空，候选是其它页面）
  const guide = guideContextFor(ui.selection);
  const roots = movingRootIds(ui.selection);
  const parents = new Set(roots.map((id) => docStore.doc.nodes[id]?.parentId ?? null));
  drag = {
    ...base,
    startX: w.x,
    startY: w.y,
    mode: "move",
    guide,
    guideKey: parents.size === 1 ? [...parents][0] : null,
    snapRects: snapRectsOf(ui.selection),
    lastScreen: { x: sx, y: sy },
    lastMods: { alt: e.altKey, meta: e.metaKey, shift: e.shiftKey },
  };
}

/**
 * 移动拖拽的每帧重算：偏移、插槽、落点、插入索引、参考线上下文。
 * 指针事件与边缘自动滚屏共用（滚屏后按同一屏幕坐标重新求世界坐标）。
 */
function updateMoveDrag() {
  const d = drag;
  if (!d || d.mode !== "move" || !d.lastScreen) return;
  const { x: sx, y: sy } = d.lastScreen;
  // 3px 阈值：双击/手抖不产生移动命令
  if (!d.moved) {
    if (Math.hypot(sx - d.downX, sy - d.downY) < 3) return;
    d.moved = true;
  }
  const w = screenToWorld(vp, sx, sy);
  d.offsetX = w.x - d.startX;
  d.offsetY = w.y - d.startY;

  // 插槽优先：拖进实例插槽仍走 slot.fill，不做普通换父级
  const slot = slotUnder(vp, w.x, w.y, ui.selection);
  if (d.dropSlot !== slot) d.dropSlot = slot;

  const roots = movingRootIds(ui.selection);
  const target = slot ? null : dropTargetAt(w.x, w.y, ui.selection);
  d.drop = target;
  d.dropActive = Boolean(
    target && roots.some((id) => dropAllowed(id, target) && docStore.doc.nodes[id]?.parentId !== target.id),
  );
  d.dropLayout = Boolean(target && target.kind === "container" && docStore.doc.nodes[target.id]?.layout);
  d.dropIndex = target && d.dropLayout ? reorderIndexAt(target.id, w.x, w.y, ui.selection) : undefined;

  // 参考线上下文跟随落点父级：落点画板/页面 → 用它；无落点或落点不合法 → 退回同父（旧行为）
  const parents = new Set(roots.map((id) => docStore.doc.nodes[id]?.parentId ?? null));
  const usable = Boolean(target && roots.some((id) => dropAllowed(id, target)));
  const ctxParent = target && usable ? target.id : parents.size === 1 ? [...parents][0] : null;
  if ((d.guideKey ?? null) !== ctxParent) {
    d.guideKey = ctxParent;
    d.guide = ctxParent ? guideContextForParent(ctxParent, ui.selection) : null;
  }

  const alt = d.lastMods?.alt ?? false;
  const meta = d.lastMods?.meta ?? false;
  // ⌘ = 落成绝对定位子项：位置由拖动决定，不画插入线、也不关吸附
  const layoutTarget = Boolean(target && d.dropLayout && usable && !meta);

  // 让位预览：每个能落进去的根各占一个槽；容器/索引不变时复用
  const insertRoots = target && layoutTarget ? roots.filter((id) => dropAllowed(id, target)) : [];
  const previewKey = target && layoutTarget ? `${target.id}:${d.dropIndex ?? 0}:${insertRoots.join(",")}` : "";
  if (previewKey !== insertPreviewKey) {
    insertPreviewKey = previewKey;
    if (previewKey || insertPreview) {
      const boxes = target && layoutTarget ? buildInsertPreview(target.id, d.dropIndex ?? 0, insertRoots) : null;
      insertPreview = retargetInsertPreview(insertPreview?.boxes ?? null, boxes ?? new Map(), performance.now());
    }
  }

  if (layoutTarget && target) {
    // 进流位置由求解器决定：只画插入线，不做吸附
    guideLines = reorderGuide(target.id, w.x, w.y);
    gapMarks = [];
  } else if (snapEnabled.value && !alt && d.guide && d.snapRects?.length) {
    const guides = computeGuides(d.snapRects, d.guide.targets, { dx: d.offsetX, dy: d.offsetY }, vp.zoom);
    d.offsetX = guides.dx;
    d.offsetY = guides.dy;
    guideLines = guides.lines;
    gapMarks = guides.gaps;
  } else {
    guideLines = [];
    gapMarks = [];
  }
  markDirty();
}

function onPointerMove(e: PointerEvent) {
  const pointerRect = canvasRef.value?.getBoundingClientRect();
  if (pointerRect) lastPointer = { x: e.clientX - pointerRect.left, y: e.clientY - pointerRect.top };
  if (guideDrag) {
    const world = screenToWorld(vp, e.clientX - (pointerRect?.left ?? 0), e.clientY - (pointerRect?.top ?? 0));
    guideDrag = { axis: guideDrag.axis, world };
    markDirty();
    return;
  }
  if (marquee) {
    marquee.x = e.clientX - (pointerRect?.left ?? 0);
    marquee.y = e.clientY - (pointerRect?.top ?? 0);
    if (!marquee.active && Math.hypot(marquee.x - marquee.startX, marquee.y - marquee.startY) > 3) {
      marquee.active = true;
    }
    if (marquee.active) updateMarqueeSelection();
    markDirty();
    return;
  }
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
    viewportNav.invalidateFit();
  } else if (ui.mode !== "edit") {
    // 非编辑模式一律不允许移动/缩放/绘制（防御：模式在拖动中被切换时不留下残留手势）
    drag = null;
    resizePreview = null;
    vectorPreview = null;
    preview = null;
    guideLines = [];
    gapMarks = [];
    clearInsertPreview();
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
  } else if (drag.mode === "crop") {
    const world = screenToWorld(vp, sx, sy);
    if (applyCropDrag(drag, world)) drag.moved = true;
  } else if (drag.mode === "rotate") {
    if (rotateState) applyRotate(rotateState, w, e.shiftKey);
  } else if (drag.mode === "multi-resize") {
    if (multiScale) applyMultiScale(multiScale, w, e.shiftKey);
  } else if (drag.mode === "move") {
    drag.lastScreen = { x: sx, y: sy };
    drag.lastMods = { alt: e.altKey, meta: e.metaKey, shift: e.shiftKey };
    updateMoveDrag();
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
    if (snapEnabled.value && !e.altKey && !e.shiftKey && node && drag.guide) {
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
    if (snapEnabled.value && !e.altKey && page) {
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

/** 文档树里的 z 序键（页面序号 + 每层子索引），用于多根一起落下时保持相对顺序。 */
function zOrderKey(id: NodeId): number[] {
  const key: number[] = [];
  let cur: DocNode | undefined = docStore.doc.nodes[id];
  while (cur) {
    const parent = cur.parentId ? docStore.doc.nodes[cur.parentId] : null;
    if (!parent) {
      key.unshift(docStore.doc.rootIds.indexOf(cur.id));
      break;
    }
    key.unshift(parent.children.indexOf(cur.id));
    cur = parent;
  }
  return key;
}

function compareZ(a: NodeId, b: NodeId): number {
  const ka = zOrderKey(a);
  const kb = zOrderKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const va = ka[i] ?? -1;
    const vb = kb[i] ?? -1;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** 当前位置在“排除其它移动根之后”的流内索引（与 reorderIndexAt 的计数口径一致）。 */
function currentFlowIndex(node: DocNode, moving: Set<NodeId>): number {
  const parent = node.parentId ? docStore.doc.nodes[node.parentId] : null;
  if (!parent) return -1;
  let index = 0;
  for (const childId of parent.children) {
    if (childId === node.id) break;
    if (moving.has(childId)) continue;
    const child = docStore.doc.nodes[childId];
    if (!child || !child.visible || child.layoutAbsolute) continue;
    index += 1;
  }
  return index;
}

/** 离开自动布局父级时，fill 在非布局容器里没有意义：归一成 fixed。 */
function sizingPatch(node: DocNode, target: DropTarget): Partial<DocNode> | null {
  if (docStore.doc.nodes[target.id]?.layout) return null;
  const patch: Partial<DocNode> = {};
  if (node.layoutSizingW === "fill") patch.layoutSizingW = "fixed";
  if (node.layoutSizingH === "fill") patch.layoutSizingH = "fixed";
  return Object.keys(patch).length ? patch : null;
}

/**
 * 移动拖拽的提交：每个移动根各自判定落点，能落的 reparent、不能落的仅平移；
 * 整批命令 = 一个撤销条目。跨页落下时松手才切活动页（Q3）。
 */
function commitMoveDrag(d: NonNullable<typeof drag>, e: PointerEvent): void {
  const roots = movingRootIds(ui.selection).sort(compareZ);
  const target = d.drop;
  const dx = d.offsetX;
  const dy = d.offsetY;
  const meta = e.metaKey;
  const cmds: Command[] = [];
  const moving = new Set(roots);
  let landedPage: NodeId | null = null;

  // 布局落点：按 z 序给每个能落进去的根分配连续插入位
  const insertAt = new Map<NodeId, number>();
  if (target && d.dropLayout) {
    let cursor = d.dropIndex ?? 0;
    for (const id of roots) {
      if (!dropAllowed(id, target) || !docStore.doc.nodes[id]) continue;
      insertAt.set(id, cursor);
      cursor += 1;
    }
  }

  for (const id of roots) {
    const node = docStore.doc.nodes[id];
    const rect = worldRect(docStore.doc, id);
    if (!node || !rect || isLocked(id)) continue;
    const allowed = target ? dropAllowed(id, target) : false;

    if (target && allowed && node.parentId !== target.id) {
      const parentRect = worldRect(docStore.doc, target.id);
      if (!parentRect) continue;
      const params: { nodeId: NodeId; parentId: NodeId; x: number; y: number; index?: number } = {
        nodeId: id,
        parentId: target.id,
        x: rect.x + dx - parentRect.x,
        y: rect.y + dy - parentRect.y,
      };
      if (d.dropLayout && !meta) {
        // 进流：位置交给求解器
        params.index = insertAt.get(id) ?? 0;
        cmds.push({ type: "node.reparent", params });
        if (node.layoutAbsolute) {
          cmds.push({ type: "node.update", params: { nodeId: id, patch: { layoutAbsolute: false } } });
        }
      } else if (d.dropLayout) {
        // ⌘：落成绝对定位子项，保留世界坐标
        cmds.push({ type: "node.reparent", params });
        if (!node.layoutAbsolute) {
          cmds.push({ type: "node.update", params: { nodeId: id, patch: { layoutAbsolute: true } } });
        }
      } else {
        // 非布局画板：追加到末尾（置顶）
        cmds.push({ type: "node.reparent", params });
        const patch = sizingPatch(node, target);
        if (patch) cmds.push({ type: "node.update", params: { nodeId: id, patch } });
      }
      landedPage = target.pageId;
      continue;
    }

    if (target && allowed && node.parentId === target.id && d.dropLayout) {
      if (!meta) {
        // 同父布局：按插入索引重排（索引没变就不产生命令）
        const index = insertAt.get(id);
        if (index !== undefined && index !== currentFlowIndex(node, moving)) {
          cmds.push({ type: "node.reparent", params: { nodeId: id, parentId: target.id, index } });
        }
      } else {
        // ⌘：就地转绝对定位并跟随指针
        const patch: Partial<DocNode> = { x: node.x + dx, y: node.y + dy };
        if (!node.layoutAbsolute) patch.layoutAbsolute = true;
        cmds.push({ type: "node.update", params: { nodeId: id, patch } });
      }
      continue;
    }

    // 无落点 / 非法落点 / 同父非布局：只平移
    if (dx || dy) {
      cmds.push({ type: "node.update", params: { nodeId: id, patch: { x: node.x + dx, y: node.y + dy } } });
    }
  }

  if (cmds.length) dispatch(cmds, "move");
  if (landedPage && landedPage !== ui.activePageId) {
    // 不走 setActivePage：它会按「父级 = 页面」过滤选区，落进画板里的节点会被清掉
    ui.activePageId = landedPage;
    ui.expandedPageId = landedPage;
  }
}

function onPointerUp(e: PointerEvent) {
  if (guideDrag) {
    const rect = canvasRef.value?.getBoundingClientRect();
    const sx = rect ? e.clientX - rect.left : 0;
    const sy = rect ? e.clientY - rect.top : 0;
    // 拖回标尺里松手 = 取消
    const inRuler = sx < RULER_SIZE || sy < RULER_SIZE;
    const pending = guideDrag;
    guideDrag = null;
    dragging.value = false;
    if (!inRuler) commitGuide(pending.axis, pending.world);
    markDirty();
    return;
  }
  if (marquee) {
    const wasActive = marquee.active;
    marquee = null;
    dragging.value = false;
    // 没拖动 = 点击空白：清空选区
    if (!wasActive) select([]);
    markDirty();
    return;
  }
  if (!drag) return;
  dragging.value = false;
  clearInsertPreview();
  // 只有编辑模式才提交移动/缩放；模式被切换过就整段丢弃（不产生命令、不留预览）
  if (drag.mode !== "pan" && ui.mode !== "edit") {
    if (drag.mode === "crop") endCropDrag();
    resizePreview = null;
    vectorPreview = null;
    preview = null;
    drag = null;
    guideLines = [];
    gapMarks = [];
    markDirty();
    return;
  }
  if (drag.mode === "pan") {
    const pan = drag;
    drag = null;
    preview = null;
    guideLines = [];
    gapMarks = [];
    const rect = canvasRef.value?.getBoundingClientRect();
    const sx = e.clientX - (rect?.left ?? 0);
    const sy = e.clientY - (rect?.top ?? 0);
    // 拖动模式单击页面（没有拖动位移）也切页 + 适配；按住拖动保持平移
    if (Math.hypot(sx - pan.startX, sy - pan.startY) <= 3) {
      const world = screenToWorld(vp, sx, sy);
      const pageId = pageAt(world.x, world.y);
      // 点当前页不重复缩放，只有真的换页才适配
      if (pageId && pageId !== ui.activePageId) {
        activatePage(pageId);
        notePageSwitchClick(sx, sy);
      }
    }
    markDirty();
    return;
  }
  if (drag.mode === "rotate") {
    endRotate();
    rotateState = null;
    drag = null;
    markDirty();
    return;
  }
  if (drag.mode === "multi-resize") {
    endMultiScale();
    multiScale = null;
    drag = null;
    markDirty();
    return;
  }
  if (drag.mode === "crop") {
    endCropDrag();
    drag = null;
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
    if (!filled) commitMoveDrag(drag, e);
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
  viewportNav.invalidateFit();
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
  viewportNav.invalidateFit();
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

  // 方向键微移：1px，⇧ 10px；连按合并成一条撤销
  const step = e.shiftKey ? 10 : 1;
  const nudgeX = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
  const nudgeY = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
  if (
    (nudgeX !== 0 || nudgeY !== 0) &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    ui.mode === "edit" &&
    !ui.cropNodeId &&
    !textEdit.value &&
    !pageRename.value
  ) {
    e.preventDefault();
    nudgeSelection(nudgeX, nudgeY);
    return;
  }

  if (e.key !== "Escape") return;

  if (marquee) {
    if (marquee.active) select(marquee.base);
    marquee = null;
    dragging.value = false;
    markDirty();
    return;
  }

  if (ui.cropNodeId) {
    ui.cropNodeId = null;
    markDirty();
    return;
  }

  // 拖动中 Esc：放弃整次手势（不产生命令，几何与父级保持原样）
  if (drag) {
    cancelDrag();
    return;
  }
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
  gridCtx = gridCanvasRef.value!.getContext("2d");
  const docCtx = docCanvasRef.value!.getContext("2d");
  if (docCtx) backend = new Canvas2DBackend(docCtx);
  hooks.getScreenshot = async (region) => {
    // 离屏重绘文档，不包含选中框、参考线、插槽占位等 UI 叠加层
    const off = document.createElement("canvas");
    const offCtx = off.getContext("2d");
    if (!offCtx) return "";

    // 截图只覆盖视口（或给定 region）：先把相交的位图解码好，再交给同步渲染。
    // 不传 resolveImage 的话 drawDocument 会把所有图片画成占位灰叉。
    const viewportRegion = { x: vp.x, y: vp.y, width: vp.width / vp.zoom, height: vp.height / vp.zoom };
    const refs = imageRefsOf(docStore.doc, { region: region ?? viewportRegion });
    await Promise.all(refs.assetIds.map((id) => ensureAssetDecoded(id).catch(() => null)));
    // 链接图抓不到也不阻断截图：画成占位即可（与"断网用旧缓存"的约定一致）
    await Promise.all(refs.urls.map((url) => ensureLinkedImage(url).catch(() => null)));
    // 字体同理：刚导入字体就截图时，别落成回退字体
    await document.fonts.ready;

    const offBackend = new Canvas2DBackend(offCtx);
    offBackend.beginFrame(vp);
    drawDocument(offBackend, docStore.doc, {
      resolveImage: (assetId) => imageFor(assetId),
      resolveLinkedImage: (url) => linkedImage(url),
    });
    offBackend.endFrame();
    if (!region) return off.toDataURL("image/png");

    // 文档坐标 → 离屏像素；超出画布的部分裁掉
    const scale = vp.zoom * vp.dpr;
    const sx = Math.max(0, (region.x - vp.x) * scale);
    const sy = Math.max(0, (region.y - vp.y) * scale);
    const ex = Math.min(off.width, (region.x + region.width - vp.x) * scale);
    const ey = Math.min(off.height, (region.y + region.height - vp.y) * scale);
    const width = Math.max(1, Math.round(ex - sx));
    const height = Math.max(1, Math.round(ey - sy));
    const cropped = document.createElement("canvas");
    cropped.width = width;
    cropped.height = height;
    const croppedCtx = cropped.getContext("2d");
    if (!croppedCtx) return "";
    croppedCtx.drawImage(off, sx, sy, width, height, 0, 0, width, height);
    return cropped.toDataURL("image/png");
  };
  hooks.focusNode = focusNode;
  hooks.focusPage = focusPage;
  hooks.fitActivePage = fitActivePage;
  hooks.activatePage = activatePage;
  hooks.insertImageBytes = (bytes, name) => insertImages([{ bytes, name }], imageDeps, viewportCenterWorld(imageDeps));
  hooks.pasteNodes = () => pasteNodesFromClipboard(pasteDeps);
  hooks.selectAllLayers = selectAllInPage;
  hooks.renderExport = async (request) => {
    // 纯组件稿（没有页面）也要能导出选区：pageId 只用来取基准，可缺省
    const pageId = request.pageId ?? ensureActivePage()?.id ?? null;
    const selected = ui.selection.filter((id) => {
      const node = docStore.doc.nodes[id];
      return !!node && node.type !== "page";
    });
    const nodeIds = request.nodeIds ?? (selected.length > 0 ? selected : undefined);
    if (!pageId && !nodeIds?.length) return "";
    return renderPngAsync(docStore.doc, {
      pageId: pageId ?? undefined,
      nodeIds,
      scale: request.scale,
      resolveImage: (assetId) => imageFor(assetId),
      resolveLinkedImage: (url) => linkedImage(url),
      ensureImage: ensureAssetDecoded,
      ensureLinkedImage,
    });
  };
  hooks.startRenameOf = (id) => {
    const node = docStore.doc.nodes[id];
    if (!node) return;
    if (node.type === "page") {
      // 先把这一页铺满视口，改名输入框才落在看得见的地方
      ui.activePageId = node.id;
      ui.expandedPageId = node.id;
      fitActivePage();
      startLabelRename(node);
      return;
    }
    if (node.type === "component") {
      // 母版回根节点：输入框贴在它的名称标签上，和画布双击标签一致
      select([id]);
      startLabelRename(node);
      return;
    }
    select([id]);
    startRenameForSelection();
  };
  hooks.deleteSelectionNow = () => deleteSelectionAction(pen);
  hooks.copySelectionPng = () => void copySelectionAsPng();
  hooks.getActivePageId = () => {
    if (ui.mode === "edit") return ensureActivePage()?.id ?? null;
    return pageAtViewportCenter()?.id ?? null;
  };
  hooks.insertInstance = insertInstance;
  hooks.getViewport = () => ({ x: vp.x, y: vp.y, width: vp.width, height: vp.height, zoom: vp.zoom });
  hooks.revealAgentActivity = () => {
    const pageId = agentActivity.pageId;
    const bounds = unionRects(agentActivity.rects);
    // 跨页先切活动页：有改动范围就随后直接飞过去，没有（如 create_page）就适配整页
    if (pageId && pageId !== ui.activePageId) activatePage(pageId, !bounds);
    if (bounds) focusBounds(bounds, 160);
    markDirty();
  };
  hooks.requestRedraw = markDirty;
  unsub = docStore.subscribe(markDirty);
  stopShortcuts = registerShortcuts({
    "file.insertImage": () => openImagePicker(imageInput.value),
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
    "edit.copyImage": () => void copySelectionAsPng(),
    "edit.group": () => groupSelection(),
    "edit.ungroup": () => ungroupSelection(),
    "edit.rename": () => startRenameForSelection(),
    "edit.delete": () => deleteSelectionAction(pen),
    "edit.duplicate": () => duplicateSelection(),
    "edit.moveForward": () => reorderSelection("forward"),
    "edit.moveBackward": () => reorderSelection("backward"),
    "edit.moveToFront": () => reorderSelection("front"),
    "edit.moveToBack": () => reorderSelection("back"),
    "component.create": createComponentFromSelection,
    "component.detach": detachSelection,
    "view.zoomIn": () => zoomStep(1.2),
    "view.zoomOut": () => zoomStep(1 / 1.2),
    "view.zoomReset": resetZoom,
    "view.fit": () => fitView(),
    "view.fitAll": () => fitAll(),
    "view.toggleGrid": () => toggleView("grid"),
    "view.toggleSnap": () => toggleView("snap"),
    "view.toggleGuides": () => toggleView("guides"),
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
      // 选区变化要重绘：选中框与「选中量距」都直接读 ui.selection
      markDirty();
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
  window.addEventListener("blur", onWindowBlurEndGesture);
});

onBeforeUnmount(() => {
  if (resizeTimer) clearTimeout(resizeTimer);
  cancelAnimationFrame(raf);
  unsub();
  stopModeWatch();
  stopSelectionWatch();
  stopShortcuts();
  ro?.disconnect();
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("pointerdown", draftGuards.onWindowPointerDown, true);
  window.removeEventListener("blur", draftGuards.onWindowBlur);
  window.removeEventListener("blur", onWindowBlurEndGesture);
});
</script>

<template>
  <div class="viewport" @dragover.prevent @drop="onCanvasDrop" @contextmenu="onContextMenu">
    <canvas ref="gridCanvasRef" class="canvas canvas-grid" aria-hidden="true" />
    <canvas ref="docCanvasRef" class="canvas canvas-doc" aria-hidden="true" />
    <canvas
      ref="canvasRef"
      class="canvas canvas-ui"
      :style="{ cursor }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="onPointerLeave"
      @dblclick="onDoubleClick"
      @wheel.prevent="onWheel"
    />

    <!-- 空文档引导：没有页面时先建页，避免画在空气里 -->
    <div v-if="!hasPage" class="empty-doc glass">
      <span class="empty-title">{{ t("canvas.emptyTitle") }}</span>
      <span class="empty-hint">{{ t("canvas.emptyHint") }}</span>
      <button class="empty-action" @click="createFirstPage">{{ t("pages.add") }}</button>
    </div>

    <!-- 行内改名（页面名 / 图层名，F2） -->
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

    <div v-if="DEV_HUD" class="dev-hud">{{ devHud }}</div>

    <input
      ref="imageInput"
      class="image-input"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
      multiple
      @change="onImagePicked"
    />

    <div class="zoom-bar glass">
      <button v-tip="{ label: t('canvas.zoomOut'), shortcut: keyOf('view.zoomOut') }" @click="zoomStep(1 / 1.2)">−</button>
      <button class="zoom-pct" v-tip="{ label: t('canvas.zoomSelect') }" @click="zoomMenuOpen = !zoomMenuOpen">{{ zoomPct }}%</button>
      <button v-tip="{ label: t('canvas.zoomIn'), shortcut: keyOf('view.zoomIn') }" @click="zoomStep(1.2)">＋</button>
      <span class="z-divider" />
      <button class="z-fit" v-tip="{ label: ui.mode === 'edit' ? t('canvas.fitActive') : t('canvas.fitAll'), shortcut: keyOf('view.fit') }" @click="fitView()">
        <Icon name="fit" :size="13" />
      </button>
      <button class="z-fit" v-tip="{ label: t('canvas.viewAll'), shortcut: keyOf('view.fitAll') }" @click="fitAll()">
        <Icon name="pages" :size="13" />
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
        <span>{{ ui.mode === "edit" ? t("canvas.fitActive") : t("canvas.fitAll") }}</span>
        <span class="check"><Icon name="fit" :size="11" /></span>
      </button>
    </div>
  </div>
</template>

<style scoped src="./canvas-view.css"></style>
