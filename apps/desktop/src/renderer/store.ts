/**
 * 应用状态桥：DocStore（非响应式，命令驱动）↔ Vue reactive UI 状态。
 * 纪律：画布热路径不进 Vue 响应式；store 变更通过订阅推增量。
 *
 * 多标签之后（ADR-0041）：每个文档标签一套真实 `DocStore`，模块级 `docStore` 是转发到
 * 活动标签的**门面**；`ui` 里按标签记的字段也是转发到 `sessionState` 的访问器。
 * 63 个直接 import 的文件因此仍然按「只有一个 store / 一个 ui」的方式写。
 */
import { nextTick, reactive } from "vue";
import {
  firstPageId,
  NUMERIC_TOKEN_CHANGED,
  type ChangeListener,
  type Command,
  type DocNode,
  type DocState,
  type DocStore,
  type NodeId,
} from "@sqraft/core";
import { agentReport, clearAgentReport, setAgentReport, type AgentChange, type AgentDiagnostic } from "./agent-report";
import { resetAgentActivity } from "./canvas/agent-activity";
import { panelsUi } from "./focus";
import {
  activeSession,
  activeStore,
  createDocTab,
  isDocActive,
  sessionState,
  type EditorMode,
  type PanelTab,
  type ToolKind,
} from "./sessions";
import { textSizeOf } from "./text-metrics";

export type { EditorMode, InspectorTab, PanelTab, ToolKind } from "./sessions";
export type { TabSession } from "./sessions";

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

/**
 * `docStore` 的门面：身份稳定，方法转发到活动标签的真实例。
 * 新增代码如果要按 `DocStore` 类型接收它，会得到类型错误——用 `docStore.active`。
 */
class DocStoreFacade {
  private listeners = new Set<ChangeListener>();
  private off: (() => void) | null = null;

  constructor() {
    this.rebind();
  }

  /** 活动标签的真实例：MCP 执行器、钢笔、渐变手势这类需要 `DocStore` 类型的调用点用。 */
  get active(): DocStore {
    return activeStore();
  }

  get doc(): DocState {
    return activeStore().doc;
  }

  get isDirty(): boolean {
    return activeStore().isDirty;
  }

  get canUndo(): boolean {
    return activeStore().canUndo;
  }

  get canRedo(): boolean {
    return activeStore().canRedo;
  }

  apply(cmds: Command | Command[], label = "edit"): void {
    this.mutable("apply");
    activeStore().apply(cmds, label);
  }

  applyDerived(cmds: Command | Command[]): void {
    this.mutable("applyDerived");
    activeStore().applyDerived(cmds);
  }

  transact<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
    this.mutable("transact");
    return activeStore().transact(label, fn);
  }

  abortTransact(): void {
    activeStore().abortTransact();
  }

  replace(state: DocState): void {
    // Home 上"替换文档"等价于打开一份新文档：没有活动文档时开一个标签
    if (!isDocActive()) {
      const tab = createDocTab(state);
      activateTab(tab.id);
      return;
    }
    activeStore().replace(state);
  }

  markSaved(): void {
    this.mutable("markSaved");
    activeStore().markSaved();
  }

  undo(): boolean {
    return activeStore().undo();
  }

  redo(): boolean {
    return activeStore().redo();
  }

  snapshot(): DocState {
    return activeStore().snapshot();
  }

  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 切标签后重新挂到新的真实例上（旧的监听解掉，外面的订阅者不受影响）。 */
  rebind(): void {
    this.off?.();
    this.off = activeStore().subscribe((state, changed) => this.emit(state, changed));
  }

  /** 切标签时重放一次全量变更：UI 版本号、画布重绘、标题、agent 清单一起刷新。 */
  emitAll(): void {
    this.emit(this.doc, new Set(Object.keys(this.doc.nodes) as NodeId[]));
  }

  private emit(state: DocState, changed: Set<NodeId>): void {
    for (const fn of this.listeners) fn(state, changed);
  }

  private mutable(op: string): void {
    if (!isDocActive()) throw new Error(`Home 标签没有文档，不能执行 ${op}`);
  }
}

export const docStore = new DocStoreFacade();

export const ui = reactive({
  version: 0,
  /** 活动标签是不是文档（Home 上画布与文档类动作全部让位） */
  get docOpen(): boolean {
    return isDocActive();
  },
  get mode(): EditorMode {
    return activeSession().view.mode;
  },
  set mode(value: EditorMode) {
    activeSession().view.mode = value;
  },
  get tool(): ToolKind {
    return activeSession().view.tool;
  },
  set tool(value: ToolKind) {
    activeSession().view.tool = value;
  },
  /** 编辑模式下的唯一活动页（UI 状态，不是文档状态） */
  get activePageId(): NodeId | null {
    return activeSession().view.activePageId;
  },
  set activePageId(value: NodeId | null) {
    activeSession().view.activePageId = value;
  },
  /** 左栏手风琴展开的页面（纯 UI 状态，无"当前页"概念） */
  get expandedPageId(): NodeId | null {
    return activeSession().view.expandedPageId;
  },
  set expandedPageId(value: NodeId | null) {
    activeSession().view.expandedPageId = value;
  },
  /** 图层树里容器行的展开状态（未点过的行：实例折叠，其它容器展开） */
  get expandedLayers(): Record<NodeId, boolean> {
    return activeSession().view.expandedLayers;
  },
  set expandedLayers(value: Record<NodeId, boolean>) {
    activeSession().view.expandedLayers = value;
  },
  /** 当前进入的实例上下文（栈，Esc 逐级退出） */
  get instanceContext(): NodeId[] {
    return activeSession().view.instanceContext;
  },
  set instanceContext(value: NodeId[]) {
    activeSession().view.instanceContext = value;
  },
  /** 左栏 tab：默认页面（每标签各记各的） */
  get tab(): PanelTab {
    return activeSession().view.panelTab;
  },
  set tab(value: PanelTab) {
    activeSession().view.panelTab = value;
  },
  /** 右栏 tab：设计 / 原型 */
  get inspectorTab(): "design" | "prototype" {
    return activeSession().view.inspectorTab;
  },
  set inspectorTab(value: "design" | "prototype") {
    activeSession().view.inspectorTab = value;
  },
  /** 正在裁切的图片节点（double-click 进入，Esc 退出） */
  get cropNodeId(): NodeId | null {
    return activeSession().view.cropNodeId;
  },
  set cropNodeId(value: NodeId | null) {
    activeSession().view.cropNodeId = value;
  },
  get selection(): NodeId[] {
    return activeSession().view.selection;
  },
  set selection(value: NodeId[]) {
    activeSession().view.selection = value;
  },
  /** 演示模式：窗口级，切标签强制退出（不按标签记忆） */
  presenter: null as PresenterState | null,
  /** 左右面板是否展开：窗口级，见 focus.ts */
  panels: panelsUi,
});

/** 切标签时 `emitAll` 会带全量 changed：那是换文档，不是一次编辑，跳过全量文本重排。 */
let switchingTab = false;

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
  if (!switchingTab) queueMicrotask(() => reflowText(tokenChanged));
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

/**
 * 载入 / 新建 / 关闭文档的唯一入口。
 * 文档换了，上一份稿子的改动清单必须一起作废——否则清单指向已经不存在的节点，
 * "点击定位"会静默无反应（与撤销清空是同一类问题）。
 */
export function replaceDocument(state: DocState): void {
  docStore.replace(state);
  clearAgentReport();
}

/**
 * 切到某个标签（会话 id）。
 *
 * 顺序很重要：先把进行中的编辑落进**旧**文档（此时活动标签还是旧的），
 * 再把视口存进旧标签、换 activeId、重挂门面、恢复新标签的视口与 agent 清单，
 * 最后重放一次全量变更让 UI / 画布 / 标题一起刷新。
 *
 * 视口恢复放进 `nextTick`：从 Home 切回文档时画布还没挂载，`hooks.restoreViewport`
 * 此刻还是空实现（`CanvasView.onBeforeUnmount` 摘掉的），同步调用会被吞掉。
 * 等 DOM 更新、`onMounted` 装回 hooks 之后再恢复；期间又切走就放弃。
 */
export function activateTab(id: string): void {
  if (id === sessionState.activeId) return;
  const next = sessionState.tabs.find((tab) => tab.id === id);
  if (!next) return;

  const current = sessionState.tabs.find((tab) => tab.id === sessionState.activeId);
  if (current) {
    // 关闭活动标签后 activeId 会短暂指向已删除的 id，这时没有"旧文档"要收尾
    hooks.prepareTabSwitch();
    const viewport = hooks.getViewport();
    if (viewport) current.view.viewport = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
    current.view.agentReport = {
      changes: [...agentReport.changes],
      diagnostics: [...agentReport.diagnostics],
      total: agentReport.total,
    };
  }

  sessionState.activeId = id;
  // 演示是窗口级：切标签绝不呈现后台标签的文档；agent 描边也不能画到新文档上
  ui.presenter = null;
  resetAgentActivity();
  docStore.rebind();
  setAgentReport(
    {
      changes: [...(next.view.agentReport.changes as AgentChange[])],
      total: next.view.agentReport.total,
    },
    [...(next.view.agentReport.diagnostics as AgentDiagnostic[])],
  );
  const target = id;
  void nextTick(() => {
    if (sessionState.activeId !== target) return;
    if (next.view.viewport) hooks.restoreViewport(next.view.viewport);
    else hooks.fitActivePage();
  });
  switchingTab = true;
  try {
    docStore.emitAll();
  } finally {
    switchingTab = false;
  }
}

export function undo(): void {
  // 撤销是全局的：清单留着就会指向已经回退掉的节点，"点击定位"会跳到不存在的东西上。
  // 空栈时什么都没撤销，清单不动（不然按一下 ⌘Z 就把有效清单清掉了）。
  if (docStore.undo()) clearAgentReport();
}

export function redo(): void {
  if (docStore.redo()) clearAgentReport();
}

export function select(ids: NodeId[]): void {
  ui.selection = ids;
}

/** 多倍率导出对话框（纯 UI）。 */
export const exportMatrixUi = reactive({ open: false });

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
  /** 渲染 SVG 源码（导出、复制、MCP 共用；返回被栅格化的节点名） */
  renderExportSvg: (request: { pageId?: NodeId; nodeIds?: NodeId[] }) => Promise<{ svg: string; rasterized: string[] }>;
  /** 双击/F2/右键：给页面或图层打开行内改名（由画布实现） */
  startRenameOf: (id: NodeId) => void;
  /** 删除当前选区（跳过页面与锁定节点） */
  deleteSelectionNow: () => void;
  /** 把当前选区（或活动页）复制成 PNG / SVG 到剪贴板 */
  copySelectionAs: (format: "png" | "svg", scale: number) => void;
  /** 把当前选区（或活动页）导出成 PNG / SVG 文件 */
  exportSelectionAs: (format: "png" | "svg", scale: number) => void;
  /** 当前视口（文档坐标查询用）；画布还没挂载时返回 null */
  getViewport: () => { x: number; y: number; width: number; height: number; zoom: number } | null;
  /** 切标签前收尾：提交文本编辑 / 改名、丢弃钢笔草稿、退出裁切与锚点编辑 */
  prepareTabSwitch: () => void;
  /** 恢复某个标签记住的视口（切回来不再重新适配） */
  restoreViewport: (viewport: { x: number; y: number; zoom: number }) => void;
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
  renderExportSvg: async () => ({ svg: "", rasterized: [] }),
  startRenameOf: () => {},
  deleteSelectionNow: () => {},
  copySelectionAs: () => {},
  exportSelectionAs: () => {},
  getViewport: () => null,
  prepareTabSwitch: () => {},
  restoreViewport: () => {},
  revealAgentActivity: () => {},
  requestRedraw: () => {},
  requestRepaint: () => {},
};
