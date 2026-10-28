/**
 * 应用状态桥：DocStore（非响应式，命令驱动）↔ Vue reactive UI 状态。
 * 纪律：画布热路径不进 Vue 响应式；store 变更通过订阅推增量。
 */
import { reactive } from "vue";
import { DocStore, createEmptyDoc, firstPageId, type Command, type NodeId } from "@sqraft/core";

export type ToolKind = "select" | "frame" | "rect" | "ellipse" | "line" | "text";

export const docStore = new DocStore(createEmptyDoc());

export const ui = reactive({
  version: 0,
  tool: "select" as ToolKind,
  selection: [] as NodeId[],
});

docStore.subscribe(() => {
  ui.version += 1;
});

export function currentPageId(): NodeId | null {
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

/** ChatPanel 在 CanvasView 挂载后注入截图实现（解耦组件引用）。 */
export const hooks: { getScreenshot: () => Promise<string> } = {
  getScreenshot: async () => "",
};
