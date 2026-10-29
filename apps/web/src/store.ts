/**
 * 应用状态桥：DocStore（非响应式，命令驱动）↔ Vue reactive UI 状态。
 * 纪律：画布热路径不进 Vue 响应式；store 变更通过订阅推增量。
 */
import { reactive } from "vue";
import { DocStore, createEmptyDoc, firstPageId, type Command, type NodeId } from "@sqraft/core";

export type ToolKind = "select" | "frame" | "rect" | "ellipse" | "line" | "text";
export type PanelTab = "chat" | "pages" | "tokens";
/** 画布模式：pan = 浏览/平移，edit = 编辑活动页 */
export type EditorMode = "pan" | "edit";

export const docStore = new DocStore(createEmptyDoc());

export const ui = reactive({
  version: 0,
  mode: "edit" as EditorMode,
  tool: "select" as ToolKind,
  /** 编辑模式下的唯一活动页（UI 状态，不是文档状态） */
  activePageId: firstPageId(docStore.doc) as NodeId | null,
  selection: [] as NodeId[],
  /** 左栏手风琴展开的页面（纯 UI 状态，无"当前页"概念） */
  expandedPageId: firstPageId(docStore.doc) as NodeId | null,
  /** 左栏 tab：默认对话（每次刷新都回到对话，不持久化） */
  tab: "chat" as PanelTab,
});

docStore.subscribe(() => {
  ui.version += 1;
  if (ui.expandedPageId && !docStore.doc.nodes[ui.expandedPageId]) {
    ui.expandedPageId = firstPageId(docStore.doc);
  }
  if (ui.activePageId && !docStore.doc.nodes[ui.activePageId]) {
    ui.activePageId = firstPageId(docStore.doc);
  }
  ui.selection = ui.selection.filter((id) => docStore.doc.nodes[id]);
});

/** 切换模式：拖动模式清空选区（纯浏览）；编辑模式的取景由 CanvasView 负责。 */
export function switchMode(mode: EditorMode): void {
  if (ui.mode === mode) return;
  ui.mode = mode;
  if (mode === "pan") {
    ui.selection = [];
    ui.tool = "select";
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

/** 由 CanvasView 注入的实现（解耦组件引用）。 */
export const hooks: {
  getScreenshot: () => Promise<string>;
  focusNode: (id: NodeId) => void;
  focusPage: (id: NodeId) => void;
  /** AI 建节点的目标页：编辑模式 = 活动页，拖动模式 = 视口中心页。 */
  getActivePageId: () => NodeId | null;
  requestRedraw: () => void;
} = {
  getScreenshot: async () => "",
  focusNode: () => {},
  focusPage: () => {},
  getActivePageId: () => null,
  requestRedraw: () => {},
};
