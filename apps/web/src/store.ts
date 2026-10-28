/**
 * 应用状态桥：DocStore（非响应式，命令驱动）↔ Vue reactive UI 状态。
 * 纪律：画布热路径不进 Vue 响应式；store 变更通过订阅推增量。
 */
import { reactive } from "vue";
import { DocStore, createEmptyDoc, firstPageId, type Command, type NodeId } from "@sqraft/core";

export type ToolKind = "select" | "frame" | "rect" | "ellipse" | "line" | "text";
export type PanelTab = "pages" | "chat";

export const docStore = new DocStore(createEmptyDoc());

export const ui = reactive({
  version: 0,
  tool: "select" as ToolKind,
  selection: [] as NodeId[],
  activePageId: firstPageId(docStore.doc) as NodeId | null,
  tab: "pages" as PanelTab,
});

docStore.subscribe(() => {
  ui.version += 1;
  // 活动页面被删除时回退到第一页
  if (ui.activePageId && !docStore.doc.nodes[ui.activePageId]) {
    ui.activePageId = firstPageId(docStore.doc);
  }
  ui.selection = ui.selection.filter((id) => docStore.doc.nodes[id]);
});

export function currentPageId(): NodeId | null {
  const id = ui.activePageId;
  if (id && docStore.doc.nodes[id]) return id;
  return firstPageId(docStore.doc);
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
  requestRedraw: () => void;
} = {
  getScreenshot: async () => "",
  focusNode: () => {},
  requestRedraw: () => {},
};
