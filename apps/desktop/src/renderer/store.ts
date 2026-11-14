/**
 * 应用状态桥：DocStore（非响应式，命令驱动）↔ Vue reactive UI 状态。
 * 纪律：画布热路径不进 Vue 响应式；store 变更通过订阅推增量。
 */
import { reactive } from "vue";
import { DocStore, createEmptyDoc, firstPageId, NUMERIC_TOKEN_CHANGED, type Command, type DocNode, type NodeId } from "@sqraft/core";
import { textSizeOf } from "./text-metrics";

export type ToolKind = "select" | "frame" | "rect" | "ellipse" | "triangle" | "line" | "path" | "text";
export type PanelTab = "pages" | "tokens" | "components";
/** 画布模式：pan = 浏览/平移，edit = 编辑活动页 */
export type EditorMode = "pan" | "edit";

/** 演示模式的一屏（返回栈里记页面与滚动位置）。 */
export interface PresenterFrame {
  pageId: NodeId;
  scroll: number;
}

/** 演示模式状态：纯 UI，不进文档、不进撤销。 */
export interface PresenterState {
  pageId: NodeId;
  scroll: number;
  stack: PresenterFrame[];
}

export const docStore = new DocStore(createEmptyDoc());

export const ui = reactive({
  version: 0,
  /** 窗口两态：false = 欢迎页，true = 打开了一个文档 */
  docOpen: false,
  mode: "edit" as EditorMode,
  tool: "select" as ToolKind,
  /** 编辑模式下的唯一活动页（UI 状态，不是文档状态） */
  activePageId: firstPageId(docStore.doc) as NodeId | null,
  selection: [] as NodeId[],
  /** 左栏手风琴展开的页面（纯 UI 状态，无"当前页"概念） */
  expandedPageId: firstPageId(docStore.doc) as NodeId | null,
  /** 图层树里容器行的展开状态（未点过的行：实例折叠，其它容器展开） */
  expandedLayers: {} as Record<NodeId, boolean>,
  /** 当前进入的实例上下文（栈，Esc 逐级退出） */
  instanceContext: [] as NodeId[],
  /** 左栏 tab：默认页面（每次刷新都回到页面，不持久化） */
  tab: "pages" as PanelTab,
  /** 右栏 tab：设计 / 原型（不持久化） */
  inspectorTab: "design" as "design" | "prototype",
  /** 正在裁切的图片节点（double-click 进入，Esc 退出） */
  cropNodeId: null as NodeId | null,
  /** 演示模式：非 null 时覆盖整个窗口（不写文档、不改选区与缩放） */
  presenter: null as PresenterState | null,
});

docStore.subscribe((_state, changed) => {
  ui.version += 1;
  if (ui.expandedPageId && !docStore.doc.nodes[ui.expandedPageId]) {
    ui.expandedPageId = firstPageId(docStore.doc);
  }
  if (ui.activePageId && !docStore.doc.nodes[ui.activePageId]) {
    ui.activePageId = firstPageId(docStore.doc);
  }
  ui.selection = ui.selection.filter((id) => docStore.doc.nodes[id]);
  ui.instanceContext = ui.instanceContext.filter((id) => docStore.doc.nodes[id]?.type === "instance");
  // 裁切中的节点被删/换文档后就失效了，别让它继续拦住指针
  if (ui.cropNodeId && !docStore.doc.nodes[ui.cropNodeId]) ui.cropNodeId = null;
  // 数值 Token 改值（token 命令会带 NUMERIC_TOKEN_CHANGED 标记）可能改字号/行高：
  // 全量文本都要重算；普通编辑只需要修 auto-height 的高度。
  const tokenChanged = changed.has(NUMERIC_TOKEN_CHANGED as NodeId);
  queueMicrotask(() => reflowText(tokenChanged));
});

let reflowing = false;

/**
 * 自动尺寸文本：宽度由布局或用户决定，高度必须由测量得出；auto-width 的宽度也由内容决定。
 * 测量在 UI 层完成，写回走 applyDerived（不进撤销栈）。
 * `full=true` 用于 Token 改值：auto-width 的宽度也要重算。
 */
function reflowText(full = false): void {
  if (reflowing) return;
  const updates: Command[] = [];
  for (const n of Object.values(docStore.doc.nodes)) {
    if (n.type !== "text") continue;
    const mode = n.textAutoResize ?? "auto-width";
    if (mode === "fixed") continue;
    if (mode === "auto-width" && !full) continue;
    const size = textSizeOf(n, n.style, n.text ?? "", docStore.doc);
    const patch: Partial<DocNode> = {};
    if (mode === "auto-width" && Math.abs(size.width - n.width) > 0.5) patch.width = size.width;
    if (Math.abs(size.height - n.height) > 0.5) patch.height = size.height;
    if (Object.keys(patch).length > 0) {
      updates.push({ type: "node.update", params: { nodeId: n.id, patch } });
    }
  }
  if (updates.length === 0) return;
  reflowing = true;
  try {
    docStore.applyDerived(updates);
  } finally {
    reflowing = false;
  }
}

/** 切换模式：拖动模式清空选区（纯浏览）；编辑模式的取景由 CanvasView 负责。 */
export function switchMode(mode: EditorMode): void {
  if (ui.mode === mode) return;
  ui.mode = mode;
  if (mode === "pan") {
    ui.selection = [];
    ui.tool = "select";
    ui.instanceContext = [];
  }
}

export function dispatch(cmd: Command | Command[], label?: string): void {
  docStore.apply(cmd, label);
}

export function undo(): void {
  docStore.undo();
}

export function redo(): void {
  docStore.redo();
}

export function select(ids: NodeId[]): void {
  ui.selection = ids;
}

/** 导出 PNG 的弹窗状态（纯 UI）：导出“当前选择或活动页”。 */
export const exportUi = reactive({
  open: false,
  scale: 2,
});

/** 由 CanvasView 注入的实现（解耦组件引用）。 */
export const hooks: {
  /** 离屏重绘文档（不含 UI 叠加层）；region 为文档坐标，可只取一块。 */
  getScreenshot: (region?: { x: number; y: number; width: number; height: number }) => Promise<string>;
  focusNode: (id: NodeId) => void;
  focusPage: (id: NodeId) => void;
  /** 适配当前活动页（与缩放菜单里的「适配活动页」同一条路径） */
  fitActivePage: () => void;
  /** 切页：活动页 + 左栏展开 + 适配该页（左栏、画布点页共用） */
  activatePage: (id: NodeId) => void;
  /** AI 建节点的目标页：编辑模式 = 活动页，拖动模式 = 视口中心页。 */
  getActivePageId: () => NodeId | null;
  /** 在活动页视口中心插入组件实例（由画布实现，面板只负责调用）。 */
  insertInstance: (componentId: NodeId) => void;
  /** 把一张位图插到视口中心（⌘V / 菜单粘贴用） */
  insertImageBytes: (bytes: Uint8Array, name: string) => Promise<void>;
  /** 粘贴 sqraft 节点载荷；剪贴板里没有节点数据时返回 false（继续试图片/文本） */
  pasteNodes: () => Promise<boolean>;
  /** ⌘A：全选当前层级的可见未锁定图层（由画布实现） */
  selectAllLayers: () => void;
  /** 按倍率渲染 PNG data URL（导出、复制、MCP 共用；会先等图片解码） */
  renderExport: (request: { pageId?: NodeId; nodeIds?: NodeId[]; scale: number }) => Promise<string>;
  /** 双击/F2/右键：给页面或图层打开行内改名（由画布实现） */
  startRenameOf: (id: NodeId) => void;
  /** 删除当前选区（跳过页面与锁定节点） */
  deleteSelectionNow: () => void;
  /** 把当前选区（或活动页）复制成 PNG 到剪贴板 */
  copySelectionPng: () => void;
  /** 当前视口（文档坐标查询用）；画布还没挂载时返回 null */
  getViewport: () => { x: number; y: number; width: number; height: number; zoom: number } | null;
  /** 把视线带到 agent 刚改动的地方：必要时切页，再缩到改动包围盒（不改选区） */
  revealAgentActivity: () => void;
  /** 绘制结果变了但文档没变（字体 / 链接图 / 语言）：重绘，并让画布的渲染缓存整体失效 */
  requestRedraw: () => void;
  /**
   * 嵌入图片解码完成：只需重绘，不让缓存整体失效——缓存层自己记得画的时候哪些图还没就绪（ADR-0033）。
   * 大稿缩小时几百张图陆续解码完，若每张都让全部缓存失效，缓存永远命中不了。
   */
  requestRepaint: () => void;
} = {
  getScreenshot: async () => "",
  focusNode: () => {},
  focusPage: () => {},
  fitActivePage: () => {},
  activatePage: () => {},
  getActivePageId: () => null,
  insertInstance: () => {},
  insertImageBytes: async () => {},
  pasteNodes: async () => false,
  selectAllLayers: () => {},
  renderExport: async () => "",
  startRenameOf: () => {},
  deleteSelectionNow: () => {},
  copySelectionPng: () => {},
  getViewport: () => null,
  revealAgentActivity: () => {},
  requestRedraw: () => {},
  requestRepaint: () => {},
};
