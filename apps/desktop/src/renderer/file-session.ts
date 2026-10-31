/**
 * 当前文件的会话状态：路径、名字、磁盘时间戳、脏标记。
 * 磁盘上的文件只在 `saveDocument` 时变化——没有自动保存，也没有恢复快照。
 */
import { reactive } from "vue";
import { createEmptyDoc, firstPageId } from "@sqraft/core";
import { docStore, ui } from "./store";
import { parseDoc, serializeDoc } from "./fileio";
import { allAssets, assetEntryName, loadAssets, resetAssets } from "./assets";
import { fontEntryName, fontTable, fontsForSave, loadFonts, registerDocFonts, resetFonts } from "./fonts";

export const fileState = reactive({
  path: null as string | null,
  name: "未命名",
  mtimeMs: 0,
  /**
   * 自上次落盘以来是否有改动。
   * 这是渲染层（工具栏胶囊）的唯一真源：`docStore.isDirty` 本身不在响应式系统里，
   * 而保存走 `markSaved()` 不会 emit，靠 `ui.version` 触发重算会让圆点留在旧值上。
   */
  dirty: false,
});

const bridge = window.sqraft;

/** 单文件体积上限：超过就提示而不是让 zip 卡死界面。 */
const MAX_SAVE_BYTES = 300 * 1024 * 1024;

/** 保存时把仓库里的图片一并写进 zip（不在文档里的孤儿资源也一并带上，避免撤销后丢图）。 */
/** 保存用快照：字体表从字体仓库现算（字体是资产，不进撤销栈）。 */
function snapshotForSave(): ReturnType<typeof docStore.snapshot> {
  return { ...docStore.snapshot(), fonts: fontTable(docStore.doc) };
}

function saveEntries(): { name: string; bytes: Uint8Array }[] {
  return [
    ...allAssets().map((asset) => ({ name: assetEntryName(asset), bytes: asset.bytes })),
    ...fontsForSave(docStore.doc).map((font) => ({ name: fontEntryName(font), bytes: font.bytes })),
  ];
}

/**
 * 保存体积预检：**在打包之前**算，否则 zip 已经在内存里建好了，
 * 上限只能拦住写盘、拦不住内存峰值（文档 + 全部资源 + zip ≈ 两倍）。
 */
function estimatedSaveBytes(entries: readonly { bytes: Uint8Array }[]): number {
  const assets = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  return assets + JSON.stringify(snapshotForSave()).length;
}

/** 超限就提示并放弃保存；返回 true 表示可以继续。 */
async function withinSaveLimit(entries: readonly { bytes: Uint8Array }[]): Promise<boolean> {
  if (estimatedSaveBytes(entries) <= MAX_SAVE_BYTES) return true;
  await bridge.dialog.error(
    `文件超过 ${MAX_SAVE_BYTES / 1024 / 1024}MB，已取消保存。请减少或压缩图片后重试。`,
  );
  return false;
}

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
  resetAssets();
  resetFonts();
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

/** 关闭文档回到欢迎页（MCP 首次调用建空稿也走这里的新建入口）。 */
export async function closeDocument(): Promise<void> {
  if (!ui.docOpen) return;
  if (!(await confirmReplaceCurrent())) return;
  // 资源跟着文档生命周期走：回到欢迎页时位图与 object URL 都该释放
  resetAssets();
  resetFonts();
  docStore.replace(createEmptyDoc());
  fileState.path = null;
  fileState.name = "未命名";
  fileState.mtimeMs = 0;
  ui.docOpen = false;
  ui.selection = [];
  ui.instanceContext = [];
  ui.cropNodeId = null;
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
    const { state, files } = await parseDoc(file.bytes);
    // 先确认文件能解析，再丢弃当前文档的资源，避免打开失败后连旧图一起没了
    resetAssets();
    resetFonts();
    loadAssets(files);
    loadFonts(files);
    docStore.replace(state);
    // 必须在 replace 之后：registerDocFonts 要遍历新文档的字体表，否则注册的是旧文档
    void registerDocFonts(state);
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
  const entries = saveEntries();
  if (!(await withinSaveLimit(entries))) return false;
  const bytes = await serializeDoc(snapshotForSave(), entries);
  if (bytes.length > MAX_SAVE_BYTES) {
    await bridge.dialog.error(`文件超过 ${MAX_SAVE_BYTES / 1024 / 1024}MB，已取消保存。请减少或压缩图片后重试。`);
    return false;
  }
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
  const entries = saveEntries();
  if (!(await withinSaveLimit(entries))) return false;
  const bytes = await serializeDoc(snapshotForSave(), entries);
  if (bytes.length > MAX_SAVE_BYTES) {
    await bridge.dialog.error(`文件超过 ${MAX_SAVE_BYTES / 1024 / 1024}MB，已取消保存。请减少或压缩图片后重试。`);
    return false;
  }
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
  // 先写响应式状态（工具栏胶囊读它），再决定要不要通知主进程
  fileState.dirty = dirty;
  if (dirty === lastDirty && name === lastName) return;
  lastDirty = dirty;
  lastName = name;
  bridge.app.setDirty(dirty, name);
}

let installed = false;
/**
 * 关闭流程的全局锁：挂在 `globalThis` 上而不是模块变量上。
 * dev 热更新会重新执行本模块，模块级布尔值各实例各一份，挡不住重复请求。
 */
interface CloseState {
  busy: boolean;
}
const closeState: CloseState = ((globalThis as { __sqraftClose?: CloseState }).__sqraftClose ??= {
  busy: false,
});
/** 已注册的监听（含脏状态订阅），HMR 销毁时逐一摘掉 */
const disposers: (() => void)[] = [];

/** 安装脏状态订阅与关闭拦截；由 App 在挂载时调用一次。 */
export function installFileSession(): void {
  if (installed) return;
  installed = true;
  disposers.push(docStore.subscribe(() => syncTitle()));
  syncTitle();

  bridge.app.signalReady();

  disposers.push(
    bridge.app.onOpenRequest((path) => {
      void openDocumentPath(path);
    }),
  );

  disposers.push(
    bridge.app.onCloseRequest(async ({ quit }) => {
      if (import.meta.env.DEV) {
        console.info(`[close] request quit=${quit} dirty=${docStore.isDirty} busy=${closeState.busy}`);
      }
      if (closeState.busy) return;
      closeState.busy = true;
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
        closeState.busy = false;
      }
    }),
  );
}

/**
 * dev 热更新会重新执行本模块：旧监听不清掉的话，一次关闭会被多个实例各处理一遍。
 * 构建产物里 `import.meta.hot` 为 undefined。
 */
import.meta.hot?.dispose(() => {
  for (const off of disposers.splice(0)) off();
  installed = false;
});
