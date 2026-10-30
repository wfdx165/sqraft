/**
 * 当前文件的会话状态：路径、名字、磁盘时间戳、脏标记。
 * 磁盘上的文件只在 `saveDocument` 时变化——没有自动保存，也没有恢复快照。
 */
import { reactive } from "vue";
import { createEmptyDoc, firstPageId } from "@sqraft/core";
import { docStore, ui } from "./store";
import { parseDoc, serializeDoc } from "./fileio";

export const fileState = reactive({
  path: null as string | null,
  name: "未命名",
  mtimeMs: 0,
});

const bridge = window.sqraft;

function suggestedName(): string {
  return fileState.name === "未命名" ? "untitled.sqraft" : fileState.name;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 有未保存改动时先问"保存 / 不保存 / 取消"；返回是否继续替换当前文档。 */
async function confirmReplaceCurrent(): Promise<boolean> {
  if (!docStore.isDirty) return true;
  const choice = await bridge.dialog.unsaved();
  if (choice === "cancel") return false;
  if (choice === "discard") return true;
  return saveDocument();
}

/**
 * 新建空稿：从欢迎页进入编辑态。
 * 有未保存改动时先问"保存 / 不保存 / 取消"——`replace` 会清空撤销栈，不问就再也找不回来了。
 * 返回是否真的新建（取消时当前文档原样保留）。
 */
export async function newDocument(): Promise<boolean> {
  if (!(await confirmReplaceCurrent())) return false;
  docStore.replace(createEmptyDoc());
  fileState.path = null;
  fileState.name = "未命名";
  fileState.mtimeMs = 0;
  ui.docOpen = true;
  ui.activePageId = firstPageId(docStore.doc);
  ui.expandedPageId = ui.activePageId;
  ui.selection = [];
  ui.instanceContext = [];
  syncTitle();
  return true;
}

/** 关闭文档回到欢迎页（MCP 自动拉起时也会走这里的新建入口，见 07）。 */
export async function closeDocument(): Promise<void> {
  if (!ui.docOpen) return;
  if (!(await confirmReplaceCurrent())) return;
  docStore.replace(createEmptyDoc());
  fileState.path = null;
  fileState.name = "未命名";
  fileState.mtimeMs = 0;
  ui.docOpen = false;
  ui.selection = [];
  ui.instanceContext = [];
  syncTitle();
}

/** 打开系统对话框并载入文档；取消时什么都不变。 */
export async function openDocument(): Promise<boolean> {
  if (!(await confirmReplaceCurrent())) return false;
  const result = await bridge.file.open();
  if (result.status === "canceled") return false;
  if (result.status === "error") {
    await bridge.dialog.error(result.message);
    return false;
  }
  return adoptFile(result.file);
}

/** 按已知路径打开（最近列表 / 拖拽 / 双击文件 / 第二实例）。 */
export async function openDocumentPath(path: string): Promise<boolean> {
  if (!(await confirmReplaceCurrent())) return false;
  const result = await bridge.file.openPath(path);
  if (result.status === "canceled") return false;
  if (result.status === "error") {
    await bridge.dialog.error(result.message);
    return false;
  }
  return adoptFile(result.file);
}

async function adoptFile(file: { path: string; name: string; mtimeMs: number; bytes: Uint8Array }): Promise<boolean> {
  try {
    const state = await parseDoc(file.bytes);
    docStore.replace(state);
    ui.docOpen = true;
    fileState.path = file.path;
    fileState.name = file.name;
    fileState.mtimeMs = file.mtimeMs;
    ui.activePageId = firstPageId(state);
    ui.expandedPageId = ui.activePageId;
    ui.selection = [];
    ui.instanceContext = [];
    syncTitle();
    return true;
  } catch (error) {
    await bridge.dialog.error(`无法打开这个文件：${errorText(error)}`);
    return false;
  }
}

/** 保存到当前文件；没有路径时等价于另存为。返回是否真的落盘。 */
export async function saveDocument(): Promise<boolean> {
  if (!fileState.path) return saveDocumentAs();
  const bytes = await serializeDoc(docStore.snapshot());
  const result = await bridge.file.save({
    path: fileState.path,
    bytes,
    expectedMtimeMs: fileState.mtimeMs,
  });
  if (result.status === "ok") return markSaved(result.mtimeMs);
  if (result.status === "error") {
    await bridge.dialog.error(result.message);
    return false;
  }

  const choice = await bridge.dialog.overwrite();
  if (choice === "cancel") return false;
  if (choice === "save-as") return saveDocumentAs();

  const forced = await bridge.file.save({ path: fileState.path, bytes, expectedMtimeMs: null });
  if (forced.status === "ok") return markSaved(forced.mtimeMs);
  if (forced.status === "error") await bridge.dialog.error(forced.message);
  return false;
}

/** 另存为：始终弹系统对话框，成功后切换当前文件。 */
export async function saveDocumentAs(): Promise<boolean> {
  const bytes = await serializeDoc(docStore.snapshot());
  const result = await bridge.file.saveAs({ suggestedName: suggestedName(), bytes });
  if (result.status === "canceled") return false;
  if (result.status === "error") {
    await bridge.dialog.error(result.message);
    return false;
  }
  fileState.path = result.path;
  fileState.name = result.name;
  return markSaved(result.mtimeMs);
}

function markSaved(mtimeMs: number): boolean {
  fileState.mtimeMs = mtimeMs;
  docStore.markSaved();
  syncTitle();
  return true;
}

let lastDirty: boolean | null = null;
let lastName = "";

/** 把脏状态与文件名同步给主进程（用于窗口标题与关闭拦截）。 */
export function syncTitle(): void {
  const name = ui.docOpen ? fileState.name : "";
  const dirty = ui.docOpen && docStore.isDirty;
  if (dirty === lastDirty && name === lastName) return;
  lastDirty = dirty;
  lastName = name;
  bridge.app.setDirty(dirty, name);
}

let installed = false;
let handlingClose = false;

/** 安装脏状态订阅与关闭拦截；由 App 在挂载时调用一次。 */
export function installFileSession(): void {
  if (installed) return;
  installed = true;
  docStore.subscribe(() => syncTitle());
  syncTitle();

  bridge.app.signalReady();
  bridge.app.onNewDocumentRequest(() => {
    if (!ui.docOpen) void newDocument();
  });

  bridge.app.onOpenRequest((path) => {
    void openDocumentPath(path);
  });

  bridge.app.onCloseRequest(async ({ quit }) => {
    if (handlingClose) return;
    handlingClose = true;
    try {
      if (!docStore.isDirty) {
        bridge.app.finishClose(quit);
        return;
      }
      const choice = await bridge.dialog.unsaved();
      if (choice === "cancel") {
        bridge.app.cancelClose();
        return;
      }
      if (choice === "discard") {
        bridge.app.finishClose(quit);
        return;
      }
      if (await saveDocument()) bridge.app.finishClose(quit);
      else bridge.app.cancelClose();
    } finally {
      handlingClose = false;
    }
  });
}
