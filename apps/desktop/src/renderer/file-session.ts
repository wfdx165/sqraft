/**
 * 当前文件的会话状态：路径、名字、磁盘时间戳、脏标记。
 * 磁盘上的文件只在 `saveDocument` 时变化——没有自动保存，也没有恢复快照。
 */
import { reactive } from "vue";
import { createEmptyDoc, firstPageId } from "@sqraft/core";
import { docStore, ui } from "./store";
import { parseDoc, serializeDoc } from "./fileio";
import { appInfo } from "./app-meta";
import { allAssets, assetEntryName, loadAssets, resetAssets } from "./assets";
import { resetLinkedImages } from "./linked-images";
import { fontEntryName, fontTable, fontsForSave, loadFonts, registerDocFonts, resetFonts } from "./fonts";
import { showToast } from "./toast";
import { logError, logInfo, logWarn } from "./log";
import { t } from "./i18n";
import type { OpenedFile } from "../shared/ipc";

/** 保存入口来源：区分快捷键/菜单、工具栏、关窗流程，排查"点了没反应"时先看这里。 */
export type SaveSource = "direct" | "action" | "toolbar" | "close" | "replace";

export const fileState = reactive({
  path: null as string | null,
  name: "",
  mtimeMs: 0,
  /**
   * 自上次落盘以来是否有改动。
   * 这是渲染层（工具栏胶囊）的唯一真源：`docStore.isDirty` 本身不在响应式系统里，
   * 而保存走 `markSaved()` 不会 emit，靠 `ui.version` 触发重算会让圆点留在旧值上。
   */
  dirty: false,
});

const bridge = window.sqraft;

/** manifest 里的"生成应用版本"：元信息读不到时写 unknown——保存不能因为版本号失败。 */
async function appVersionForManifest(): Promise<string> {
  try {
    return (await appInfo()).version || "unknown";
  } catch {
    return "unknown";
  }
}

/** 单文件体积上限：超过就提示而不是让 zip 卡死界面。 */
const MAX_SAVE_BYTES = 300 * 1024 * 1024;
/** 大文档预告阈值：超过这个体量，zip 是可感知的同步卡顿，先提示一声再动手。 */
const WARN_SAVE_BYTES = 20 * 1024 * 1024;

/**
 * 超限文案：降体积的方法要真实可行。链接图（sourceUrl）字节不进文件
 * （摊在 userData/image-cache/，ADR-0027），改链接是最有效的手段之一。
 */
function overLimitMessage(): string {
  return t("file.tooLarge", { mb: MAX_SAVE_BYTES / 1024 / 1024 });
}

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
 *
 * 参数是**已经取好的快照**：函数内部会全量 `JSON.stringify` 文档，
 * 每次保存只允许调用一次（调用方把快照复用给 `serializeDoc`，别重复 `snapshotForSave()`）。
 */
function estimatedBytesOf(
  snapshot: ReturnType<typeof docStore.snapshot>,
  entries: readonly { bytes: Uint8Array }[],
): number {
  const assets = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  return assets + JSON.stringify(snapshot).length;
}

/**
 * 大文档预告：zip 是同步压缩，体量大时 UI 会有可感知的停顿。
 * 先发 toast，再让出一次任务队列让 toast 画出来，然后才同步压缩。
 */
async function warnLargeSaveIfAny(estimated: number): Promise<void> {
  if (estimated <= WARN_SAVE_BYTES) return;
  showToast(t("file.largeSaving", { mb: Math.ceil(estimated / 1024 / 1024) }));
  await new Promise((resolve) => setTimeout(resolve, 60));
}

/** 超限就提示并放弃保存；`estimated` 由调用方算好传进来，避免重复快照。 */
async function withinSaveLimit(estimated: number, source: SaveSource): Promise<boolean> {
  if (estimated <= MAX_SAVE_BYTES) return true;
  logWarn("save: over limit", { source, estimatedBytes: estimated, limitBytes: MAX_SAVE_BYTES });
  await bridge.dialog.error(overLimitMessage());
  return false;
}

function suggestedName(): string {
  return fileState.name || "untitled.sqraft";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 有未保存改动时先问"保存 / 不保存 / 取消"；返回是否继续替换当前文档。 */
async function confirmReplaceCurrent(): Promise<boolean> {
  if (!docStore.isDirty) return true;
  const choice = await bridge.dialog.unsaved();
  logInfo("replace: unsaved choice", { choice });
  if (choice === "cancel") return false;
  if (choice === "discard") return true;
  return saveDocument("replace");
}

/**
 * 新建空稿：从欢迎页进入编辑态。
 * 有未保存改动时先问"保存 / 不保存 / 取消"——`replace` 会清空撤销栈，不问就再也找不回来了。
 * 返回是否真的新建（取消时当前文档原样保留）。
 */
export async function newDocument(): Promise<boolean> {
  if (!(await confirmReplaceCurrent())) return false;
  resetAssets();
  resetLinkedImages();
  resetFonts();
  docStore.replace(createEmptyDoc());
  fileState.path = null;
  fileState.name = "";
  fileState.mtimeMs = 0;
  ui.docOpen = true;
  // 换文档时演示模式必须显式退出：不能指望"页面被删"的 watcher 顺带收拾
  ui.presenter = null;
  ui.activePageId = firstPageId(docStore.doc);
  ui.expandedPageId = ui.activePageId;
  ui.selection = [];
  ui.instanceContext = [];
  logInfo("document: new");
  syncTitle();
  return true;
}

/** 关闭文档回到欢迎页（MCP 首次调用建空稿也走这里的新建入口）。 */
export async function closeDocument(): Promise<void> {
  if (!ui.docOpen) return;
  if (!(await confirmReplaceCurrent())) return;
  const path = fileState.path;
  // 资源跟着文档生命周期走：回到欢迎页时位图与 object URL 都该释放
  resetAssets();
  resetLinkedImages();
  resetFonts();
  docStore.replace(createEmptyDoc());
  fileState.path = null;
  fileState.name = "";
  fileState.mtimeMs = 0;
  ui.docOpen = false;
  ui.presenter = null;
  ui.selection = [];
  ui.instanceContext = [];
  ui.cropNodeId = null;
  logInfo("document: closed", { path });
  syncTitle();
}

/** 打开系统对话框并载入文档；取消时什么都不变。 */
export async function openDocument(): Promise<boolean> {
  if (!(await confirmReplaceCurrent())) return false;
  const started = Date.now();
  const result = await bridge.file.open();
  logInfo("open: dialog result", { status: result.status, ms: Date.now() - started });
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
  const started = Date.now();
  const result = await bridge.file.openPath(path);
  logInfo("open: path result", { path, status: result.status, ms: Date.now() - started });
  if (result.status === "canceled") return false;
  if (result.status === "error") {
    await bridge.dialog.error(result.message);
    return false;
  }
  return adoptFile(result.file);
}

/** 按主进程给的一次性地址流式取回文件内容（不经 IPC 克隆，见 OpenedFile.url）。 */
async function readOpenedFile(file: OpenedFile): Promise<Uint8Array> {
  const started = Date.now();
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  logInfo("open: read", { path: file.path, bytes: bytes.length, ms: Date.now() - started });
  return bytes;
}

async function adoptFile(file: OpenedFile): Promise<boolean> {
  const started = Date.now();
  try {
    const { state, files } = await parseDoc(await readOpenedFile(file));
    // 先确认文件能解析，再丢弃当前文档的资源，避免打开失败后连旧图一起没了
    resetAssets();
    resetLinkedImages();
    resetFonts();
    loadAssets(files);
    loadFonts(files);
    docStore.replace(state);
    // 必须在 replace 之后：registerDocFonts 要遍历新文档的字体表，否则注册的是旧文档
    void registerDocFonts(state);
    ui.docOpen = true;
    ui.presenter = null;
    fileState.path = file.path;
    fileState.name = file.name;
    fileState.mtimeMs = file.mtimeMs;
    ui.activePageId = firstPageId(state);
    ui.expandedPageId = ui.activePageId;
    ui.selection = [];
    ui.instanceContext = [];
    logInfo("open: adopted", {
      path: file.path,
      nodes: Object.keys(state.nodes).length,
      assets: Object.keys(files).filter((name) => name.startsWith("assets/")).length,
      ms: Date.now() - started,
    });
    syncTitle();
    return true;
  } catch (error) {
    logError("open: failed", { path: file.path, error: errorText(error), stack: errorStack(error) });
    await bridge.dialog.error(t("file.openError", { detail: errorText(error) }));
    return false;
  }
}

/**
 * 渲染层保存互斥：进行中的保存期间再次触发（连按 ⌘S、关窗撞上手动保存）**复用同一次**，
 * 不并发跑两条"序列化 + 写盘"。并发是两类事故的源头：
 * 第二次拿旧 mtime 比对 → 假 conflict 弹框；两条 zip 同时在内存 → 大文档双倍峰值。
 * 代价是并发期间产生的新改动要再按一次保存（这条记在 02-save-race-fixes 票里）。
 */
let activeSave: Promise<boolean> | null = null;

function guardedSave(source: SaveSource, task: () => Promise<boolean>): Promise<boolean> {
  if (activeSave) {
    logWarn("save: in-flight, reusing", { source });
    return activeSave;
  }
  const run = task();
  const wrapped = run.finally(() => {
    if (activeSave === wrapped) activeSave = null;
  });
  activeSave = wrapped;
  return wrapped;
}

/** 保存到当前文件；没有路径时等价于另存为。返回是否真的落盘。 */
export function saveDocument(source: SaveSource = "direct"): Promise<boolean> {
  return guardedSave(source, () => runSave(source));
}

async function runSave(source: SaveSource): Promise<boolean> {
  if (!fileState.path) {
    logInfo("save: no path, save-as", { source });
    // 内部走 runSaveAs：套壳入口不能嵌套，否则会复用到自己（activeSave 还没赋值）
    return runSaveAs(source);
  }
  const started = Date.now();
  try {
    const entries = saveEntries();
    // 快照只取一次：体积估算与 zip 序列化共用，避免大文档多次全量 JSON 往返
    const snapshot = snapshotForSave();
    const estimated = estimatedBytesOf(snapshot, entries);
    logInfo("save: start", {
      source,
      path: fileState.path,
      dirty: docStore.isDirty,
      nodes: Object.keys(docStore.doc.nodes).length,
      entries: entries.length,
      estimatedBytes: estimated,
    });
    if (!(await withinSaveLimit(estimated, source))) return false;
    await warnLargeSaveIfAny(estimated);
    const serializeStarted = Date.now();
    const bytes = await serializeDoc(snapshot, entries, await appVersionForManifest());
    logInfo("save: serialized", { source, bytes: bytes.length, ms: Date.now() - serializeStarted });
    if (bytes.length > MAX_SAVE_BYTES) {
      logWarn("save: over limit after zip", { source, bytes: bytes.length, limitBytes: MAX_SAVE_BYTES });
      await bridge.dialog.error(overLimitMessage());
      return false;
    }
    const result = await bridge.file.save({
      path: fileState.path,
      bytes,
      expectedMtimeMs: fileState.mtimeMs,
    });
    logInfo("save: result", {
      source,
      status: result.status,
      mtimeMs: result.status === "ok" ? result.mtimeMs : undefined,
      expectedMtimeMs: fileState.mtimeMs,
      bytes: bytes.length,
      ms: Date.now() - started,
    });
    if (result.status === "ok") return markSaved(result.mtimeMs, source);
    if (result.status === "error") {
      logError("save: error", { source, message: result.message, ms: Date.now() - started });
      await bridge.dialog.error(result.message);
      return false;
    }

    const choice = await bridge.dialog.overwrite();
    logInfo("save: conflict choice", { source, choice });
    if (choice === "cancel") return false;
    if (choice === "save-as") return runSaveAs(source, "conflict");

    const forced = await bridge.file.save({ path: fileState.path, bytes, expectedMtimeMs: null });
    logInfo("save: forced result", { source, status: forced.status });
    if (forced.status === "ok") return markSaved(forced.mtimeMs, source);
    if (forced.status === "error") {
      logError("save: forced error", { source, message: forced.message });
      await bridge.dialog.error(forced.message);
    }
    return false;
  } catch (error) {
    // 序列化/写盘任何一步抛错都必须让用户看见：静默失败会让"保存"和"关窗"一起失灵
    logError("save: threw", { source, error: errorText(error), stack: errorStack(error), ms: Date.now() - started });
    await bridge.dialog.error(t("file.saveError", { detail: errorText(error) })).catch(() => undefined);
    return false;
  }
}

/** 另存为：始终弹系统对话框，成功后切换当前文件。 */
export function saveDocumentAs(source: SaveSource = "direct", reason: "direct" | "conflict" = "direct"): Promise<boolean> {
  return guardedSave(source, () => runSaveAs(source, reason));
}

async function runSaveAs(source: SaveSource, reason: "direct" | "conflict" = "direct"): Promise<boolean> {
  const started = Date.now();
  try {
    const entries = saveEntries();
    // 同 saveDocument：快照复用给体积估算与 zip，别重复全量序列化
    const snapshot = snapshotForSave();
    const estimated = estimatedBytesOf(snapshot, entries);
    logInfo("save-as: start", {
      source,
      reason,
      suggested: suggestedName(),
      entries: entries.length,
      estimatedBytes: estimated,
    });
    if (!(await withinSaveLimit(estimated, source))) return false;
    await warnLargeSaveIfAny(estimated);
    const serializeStarted = Date.now();
    const bytes = await serializeDoc(snapshot, entries, await appVersionForManifest());
    logInfo("save-as: serialized", { source, bytes: bytes.length, ms: Date.now() - serializeStarted });
    if (bytes.length > MAX_SAVE_BYTES) {
      logWarn("save-as: over limit after zip", { source, bytes: bytes.length, limitBytes: MAX_SAVE_BYTES });
      await bridge.dialog.error(overLimitMessage());
      return false;
    }
    const result = await bridge.file.saveAs({ suggestedName: suggestedName(), bytes });
    logInfo("save-as: result", {
      source,
      status: result.status,
      path: result.status === "ok" ? result.path : undefined,
      bytes: bytes.length,
      ms: Date.now() - started,
    });
    if (result.status === "canceled") return false;
    if (result.status === "error") {
      logError("save-as: error", { source, message: result.message });
      await bridge.dialog.error(result.message);
      return false;
    }
    fileState.path = result.path;
    fileState.name = result.name;
    return markSaved(result.mtimeMs, source);
  } catch (error) {
    logError("save-as: threw", { source, error: errorText(error), stack: errorStack(error) });
    await bridge.dialog.error(t("file.saveAsError", { detail: errorText(error) })).catch(() => undefined);
    return false;
  }
}

/** 栈按行拆开（单字段截断 200 字符，整段塞进去会丢掉关键帧）。 */
function errorStack(error: unknown): string[] | undefined {
  if (!(error instanceof Error) || !error.stack) return undefined;
  return error.stack.split("\n").slice(0, 12);
}

function markSaved(mtimeMs: number, source: SaveSource): boolean {
  fileState.mtimeMs = mtimeMs;
  docStore.markSaved();
  logInfo("save: marked saved", { source, mtimeMs });
  syncTitle();
  return true;
}

let lastDirty: boolean | null = null;
let lastName = "";

/** 把脏状态与文件名同步给主进程（用于窗口标题与关闭拦截）。 */
export function syncTitle(): void {
  const name = ui.docOpen ? (fileState.name || t("common.untitled")) : "";
  const dirty = ui.docOpen && docStore.isDirty;
  // 先写响应式状态（工具栏胶囊读它），再决定要不要通知主进程
  fileState.dirty = dirty;
  if (dirty === lastDirty && name === lastName) return;
  lastDirty = dirty;
  lastName = name;
  logInfo("dirty changed", { dirty, name });
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
      logInfo("close: request", { quit, dirty: docStore.isDirty, busy: closeState.busy });
      if (closeState.busy) {
        logWarn("close: dropped, already busy", { quit });
        return;
      }
      closeState.busy = true;
      let closed = false;
      try {
        if (!docStore.isDirty) {
          logInfo("close: clean, finish", { quit });
          bridge.app.finishClose(quit);
          closed = true;
          return;
        }
        const choice = await bridge.dialog.unsaved();
        logInfo("close: unsaved choice", { quit, choice });
        if (choice === "cancel") return;
        if (choice === "discard") {
          logInfo("close: discard", { quit });
          bridge.app.finishClose(quit);
          closed = true;
          return;
        }
        if (await saveDocument("close")) {
          bridge.app.finishClose(quit);
          closed = true;
        }
      } catch (error) {
        logError("close: threw", { quit, error: errorText(error), stack: errorStack(error) });
        await bridge.dialog.error(t("file.closeSaveError", { detail: errorText(error) })).catch(() => undefined);
      } finally {
        closeState.busy = false;
        // 没走成也一定要回一句：主进程的挂起不解除的话，之后的关闭请求会被永久丢弃，
        // 用户就只能强制退出（保险丝变成绊脚石）。
        if (!closed) {
          logInfo("close: canceled");
          bridge.app.cancelClose();
        }
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
