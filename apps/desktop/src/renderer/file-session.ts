/**
 * 当前文件的会话状态：路径、名字、磁盘时间戳、脏标记。
 * 磁盘上的文件只在 `saveDocument` 时变化——没有自动保存，也没有恢复快照。
 */
import { reactive, watch } from "vue";
import { createEmptyDoc, type DocState } from "@sqraft/core";
import { activateTab, docStore, hooks, replaceDocument, ui } from "./store";
import {
  MAX_DOC_TABS,
  activeSession,
  closeTab,
  createDocTab,
  docTabs,
  findDocTabByPath,
  findTab,
  rememberClosedPath,
  sessionState,
  takeClosedPath,
  type TabSession,
} from "./sessions";
import { parseDoc, serializeDoc } from "./fileio";
import { appInfo } from "./app-meta";
import { assetEntryName, assetsForSave, loadAssets, resetAssets } from "./assets";
import { resetLinkedImages } from "./linked-images";
import { fontEntryName, fontTable, fontsForSave, loadFonts, registerDocFonts, resetFonts } from "./fonts";
import { showToast } from "./toast";
import { logError, logInfo, logWarn } from "./log";
import { t } from "./i18n";
import { tabLabel } from "./tab-label";
import type { FileStat, OpenedFile } from "../shared/ipc";
import { changeStateOf } from "./external-change";

/** 保存入口来源：区分快捷键/菜单、工具栏、关窗流程，排查"点了没反应"时先看这里。 */
export type SaveSource = "direct" | "action" | "toolbar" | "close" | "replace";

/**
 * 活动标签的文件状态。
 *
 * 字段本身住在 `sessionState` 的标签记录里，这里用访问器转发——工具栏与导出代码
 * 仍然 import 同一个 `fileState`，不需要知道多标签的存在。
 */
export const fileState = reactive({
  get path(): string | null {
    return activeSession().file.path;
  },
  set path(value: string | null) {
    activeSession().file.path = value;
  },
  get name(): string {
    return activeSession().file.name;
  },
  set name(value: string) {
    activeSession().file.name = value;
  },
  get mtimeMs(): number {
    return activeSession().file.mtimeMs;
  },
  set mtimeMs(value: number) {
    activeSession().file.mtimeMs = value;
  },
  /**
   * 自上次落盘以来是否有改动。
   * 这是渲染层（工具栏胶囊）的唯一真源：`docStore.isDirty` 本身不在响应式系统里，
   * 而保存走 `markSaved()` 不会 emit，靠 `ui.version` 触发重算会让圆点留在旧值上。
   */
  get dirty(): boolean {
    return activeSession().file.dirty;
  },
  set dirty(value: boolean) {
    activeSession().file.dirty = value;
  },
  /** 磁盘上的文件在别的程序里被改过（只标记，不抢焦点；检测见 05 票） */
  get externalChange(): boolean {
    return activeSession().file.externalChange;
  },
  set externalChange(value: boolean) {
    activeSession().file.externalChange = value;
  },
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

/** 保存用快照：字体表从字体仓库现算（字体是资产，不进撤销栈）。 */
function snapshotForSave(tab: TabSession): ReturnType<typeof docStore.snapshot> {
  return { ...tab.store.snapshot(), fonts: fontTable(tab.store.doc) };
}

function saveEntries(tab: TabSession): { name: string; bytes: Uint8Array }[] {
  return [
    // 资源池是全局的（多标签共用）：只写**当前文档**引用到的位图，避免把别的标签的图带进文件
    ...assetsForSave(tab.store.doc).map((asset) => ({ name: assetEntryName(asset), bytes: asset.bytes })),
    ...fontsForSave(tab.store.doc).map((font) => ({ name: fontEntryName(font), bytes: font.bytes })),
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

function suggestedName(tab: TabSession): string {
  if (tab.file.name) return tab.file.name;
  // 未命名带编号：两个未命名文档往同一文件夹存不会撞名
  return tab.file.untitledIndex ? `untitled-${tab.file.untitledIndex}.sqraft` : "untitled.sqraft";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 上限提示：只 toast，不关任何标签，也不弹对话框。 */
function tabLimitReached(): boolean {
  if (docTabs().length < MAX_DOC_TABS) return false;
  showToast(t("tab.limit", { max: MAX_DOC_TABS }));
  logInfo("tab: limit reached", { open: docTabs().length, max: MAX_DOC_TABS });
  return true;
}

/**
 * 新建空稿：开一个新标签，不碰当前文档（多标签之后"新建"不再替换）。
 * 到上限时只提示，返回 false。
 */
export async function newDocument(): Promise<boolean> {
  if (tabLimitReached()) return false;
  const tab = createDocTab(createEmptyDoc());
  activateTab(tab.id);
  ui.presenter = null;
  logInfo("document: new", { tab: tab.id });
  syncTitle();
  return true;
}

/**
 * 打开内置示例：没有文件路径，`⌘S` 时才另存。
 * 与新建一样开新标签，不动当前文档。
 */
export async function openGeneratedDocument(title: string, state: DocState): Promise<boolean> {
  if (tabLimitReached()) return false;
  const tab = createDocTab(state, { name: title });
  activateTab(tab.id);
  ui.presenter = null;
  void registerDocFonts(state);
  logInfo("document: example", { title, tab: tab.id });
  syncTitle();
  return true;
}

/**
 * 关闭一个文档标签：脏时问「保存 / 不保存 / 取消」，保存落在**这个标签**上（不是活动标签）。
 * 返回是否真的关掉了。
 */
export async function closeTabById(id: string): Promise<boolean> {
  const tab = findTab(id);
  if (!tab || tab.kind !== "doc") return false;
  const wasActive = id === sessionState.activeId;
  // 只有活动标签有画布上的进行中编辑需要收尾
  if (wasActive) hooks.prepareTabSwitch();
  if (tab.store.isDirty) {
    const choice = await bridge.dialog.unsaved([tabLabel(tab)]);
    logInfo("close: unsaved choice", { tab: id, choice });
    if (choice === "cancel") return false;
    if (choice === "save" && !(await saveDocument("close", tab))) return false;
  }
  // 关掉之前记路径：⌘⇧T 只能恢复已保存的文件（未命名的内容已经确认丢弃）
  rememberClosedPath(tab.file.path);
  const next = closeTab(tab.id);
  if (wasActive && next) activateTab(next);
  ui.presenter = null;
  // 资源跟着文档生命周期走：所有文档都关掉时才释放位图与 object URL
  if (docTabs().length === 0) {
    resetAssets();
    resetLinkedImages();
    resetFonts();
  }
  logInfo("document: closed", { tab: id, path: tab.file.path, next: next ?? undefined });
  syncTitle();
  return true;
}

/** 关掉当前标签；最后一个文档关掉后落回 Home。 */
export async function closeDocument(): Promise<void> {
  if (!ui.docOpen) return;
  await closeTabById(activeSession().id);
}

/**
 * ⇧⌘T：恢复最近关闭的标签（只认已保存的文件；未命名内容在关闭时已确认丢弃）。
 * 文件已不在、标签到上限时由打开链路自己提示。
 */
export async function reopenClosedTab(): Promise<boolean> {
  const path = takeClosedPath();
  if (!path) {
    showToast(t("tab.noReopen"));
    return false;
  }
  const existing = findDocTabByPath(path);
  if (existing) {
    activateTab(existing.id);
    return true;
  }
  return openDocumentPath(path);
}

/* ---------- 外部改动（ADR-0041） ---------- */
let statTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleExternalCheck(delay = 300): void {
  if (statTimer) clearTimeout(statTimer);
  statTimer = setTimeout(() => {
    statTimer = null;
    void checkExternalChanges();
  }, delay);
}

/** 批量 stat 所有已保存标签：只标记，不切标签、不弹窗。 */
export async function checkExternalChanges(): Promise<void> {
  const tabs = docTabs().filter((tab) => tab.file.path);
  if (tabs.length === 0) return;
  let stats: FileStat[];
  try {
    stats = await bridge.file.stat(tabs.map((tab) => tab.file.path!));
  } catch (error) {
    logWarn("external: stat failed", { error: errorText(error) });
    return;
  }
  const byPath = new Map(stats.map((stat) => [stat.path, stat]));
  let changed = 0;
  for (const tab of tabs) {
    const stat = byPath.get(tab.file.path!);
    if (!stat) continue;
    // 文件重新出现：上次的"忽略删除"失效
    if (stat.exists) tab.file.ignoredMissing = false;
    const next = changeStateOf(tab.file, stat);
    if (next.externalChange === tab.file.externalChange && next.missing === tab.file.missing) continue;
    tab.file.externalChange = next.externalChange;
    tab.file.missing = next.missing;
    changed += 1;
  }
  if (changed > 0) logInfo("external: marked", { changed });
}

/** 「保留当前版本」：收起横幅，并记住这次 mtime（或这次删除），不再反复提示。 */
export async function keepExternalChanges(): Promise<void> {
  const tab = activeSession();
  if (tab.kind !== "doc" || !tab.file.path) return;
  try {
    const [stat] = await bridge.file.stat([tab.file.path]);
    if (stat?.exists) {
      tab.file.ignoredMtime = stat.mtimeMs;
      tab.file.ignoredMissing = false;
    } else {
      tab.file.ignoredMissing = true;
    }
  } catch (error) {
    logWarn("external: keep failed", { error: errorText(error) });
  }
  tab.file.externalChange = false;
  tab.file.missing = false;
  logInfo("external: keep", { tab: tab.id });
}

/**
 * 「重新载入」：从磁盘重新读当前标签。有脏改动时仍走保存 / 不保存 / 取消，
 * 载入后撤销栈清空（等价于重新打开这个文件）。
 */
export async function reloadActiveDocument(): Promise<boolean> {
  const tab = activeSession();
  if (tab.kind !== "doc" || !tab.file.path) return false;
  if (tab.id !== sessionState.activeId) return false;
  hooks.prepareTabSwitch();
  if (tab.store.isDirty) {
    const choice = await bridge.dialog.unsaved([tabLabel(tab)]);
    logInfo("external: reload unsaved choice", { tab: tab.id, choice });
    if (choice === "cancel") return false;
    if (choice === "save" && !(await saveDocument("close", tab))) return false;
  }
  const result = await bridge.file.openPath(tab.file.path);
  if (result.status === "canceled") return false;
  if (result.status === "error") {
    await bridge.dialog.error(result.message);
    return false;
  }
  try {
    const { state, files } = await parseDoc(await readOpenedFile(result.file));
    loadAssets(files);
    loadFonts(files);
    replaceDocument(state);
    tab.file.path = result.file.path;
    tab.file.name = result.file.name;
    tab.file.mtimeMs = result.file.mtimeMs;
    tab.file.externalChange = false;
    tab.file.missing = false;
    tab.file.ignoredMtime = null;
    tab.file.ignoredMissing = false;
    const pageId = state.rootIds.find((id) => state.nodes[id]?.type === "page") ?? null;
    ui.activePageId = pageId;
    ui.expandedPageId = pageId;
    ui.selection = [];
    ui.instanceContext = [];
    void registerDocFonts(state);
    logInfo("external: reloaded", { tab: tab.id, path: result.file.path, nodes: Object.keys(state.nodes).length });
    syncTitle();
    return true;
  } catch (error) {
    logError("external: reload failed", { tab: tab.id, error: errorText(error) });
    await bridge.dialog.error(t("file.openError", { detail: errorText(error) })).catch(() => undefined);
    return false;
  }
}

/** 打开系统对话框并载入文档；取消时什么都不变。 */
export async function openDocument(): Promise<boolean> {
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
  // 同一路径已经在某个标签里打开：聚焦它，不再开第二份（两条保存链会互相覆盖）
  const existing = findDocTabByPath(file.path);
  if (existing) {
    activateTab(existing.id);
    logInfo("open: focus existing tab", { path: file.path, tab: existing.id });
    return true;
  }
  if (tabLimitReached()) return false;
  try {
    const { state, files } = await parseDoc(await readOpenedFile(file));
    // 资源是全局池（按内容哈希），换标签不重置：别的标签还在用
    loadAssets(files);
    loadFonts(files);
    const tab = createDocTab(state, { path: file.path, name: file.name, mtimeMs: file.mtimeMs });
    activateTab(tab.id);
    // 必须在激活之后：registerDocFonts 要遍历新文档的字体表
    void registerDocFonts(state);
    ui.presenter = null;
    logInfo("open: adopted", {
      path: file.path,
      tab: tab.id,
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
 * 渲染层保存互斥：同一个标签进行中的保存期间再次触发（连按 ⌘S、关窗撞上手动保存）**复用同一次**，
 * 不并发跑两条"序列化 + 写盘"。并发是两类事故的源头：
 * 第二次拿旧 mtime 比对 → 假 conflict 弹框；两条 zip 同时在内存 → 大文档双倍峰值。
 * 多标签之间不共享锁：关后台标签时可能同时保存另一个标签，那是两个不同的文件。
 */
const activeSaves = new Map<string, Promise<boolean>>();

function guardedSave(tab: TabSession, source: SaveSource, task: () => Promise<boolean>): Promise<boolean> {
  const inFlight = activeSaves.get(tab.id);
  if (inFlight) {
    logWarn("save: in-flight, reusing", { source, tab: tab.id });
    return inFlight;
  }
  const run = task();
  const wrapped = run.finally(() => {
    if (activeSaves.get(tab.id) === wrapped) activeSaves.delete(tab.id);
  });
  activeSaves.set(tab.id, wrapped);
  return wrapped;
}

/** 保存到目标标签的文件（默认活动标签）；没有路径时等价于另存为。 */
export function saveDocument(source: SaveSource = "direct", target?: TabSession): Promise<boolean> {
  const tab = target ?? activeSession();
  if (tab.kind !== "doc") return Promise.resolve(false);
  return guardedSave(tab, source, () => runSave(source, tab));
}

async function runSave(source: SaveSource, tab: TabSession): Promise<boolean> {
  if (!tab.file.path) {
    logInfo("save: no path, save-as", { source, tab: tab.id });
    // 内部走 runSaveAs：套壳入口不能嵌套，否则会复用到自己（activeSaves 还没赋值）
    return runSaveAs(source, "direct", tab);
  }
  const started = Date.now();
  try {
    const entries = saveEntries(tab);
    // 快照只取一次：体积估算与 zip 序列化共用，避免大文档多次全量 JSON 往返
    const snapshot = snapshotForSave(tab);
    const estimated = estimatedBytesOf(snapshot, entries);
    logInfo("save: start", {
      source,
      tab: tab.id,
      path: tab.file.path,
      dirty: tab.store.isDirty,
      nodes: Object.keys(tab.store.doc.nodes).length,
      entries: entries.length,
      estimatedBytes: estimated,
    });
    if (!(await withinSaveLimit(estimated, source))) return false;
    await warnLargeSaveIfAny(estimated);
    const serializeStarted = Date.now();
    const bytes = await serializeDoc(snapshot, entries, await appVersionForManifest());
    logInfo("save: serialized", { source, tab: tab.id, bytes: bytes.length, ms: Date.now() - serializeStarted });
    if (bytes.length > MAX_SAVE_BYTES) {
      logWarn("save: over limit after zip", { source, bytes: bytes.length, limitBytes: MAX_SAVE_BYTES });
      await bridge.dialog.error(overLimitMessage());
      return false;
    }
    const result = await bridge.file.save({
      path: tab.file.path,
      bytes,
      expectedMtimeMs: tab.file.mtimeMs,
    });
    logInfo("save: result", {
      source,
      tab: tab.id,
      status: result.status,
      mtimeMs: result.status === "ok" ? result.mtimeMs : undefined,
      expectedMtimeMs: tab.file.mtimeMs,
      bytes: bytes.length,
      ms: Date.now() - started,
    });
    if (result.status === "ok") return markSaved(tab, result.mtimeMs, source);
    if (result.status === "error") {
      logError("save: error", { source, message: result.message, ms: Date.now() - started });
      await bridge.dialog.error(result.message);
      return false;
    }

    const choice = await bridge.dialog.overwrite();
    logInfo("save: conflict choice", { source, tab: tab.id, choice });
    if (choice === "cancel") return false;
    if (choice === "save-as") return runSaveAs(source, "conflict", tab);

    const forced = await bridge.file.save({ path: tab.file.path, bytes, expectedMtimeMs: null });
    logInfo("save: forced result", { source, tab: tab.id, status: forced.status });
    if (forced.status === "ok") return markSaved(tab, forced.mtimeMs, source);
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

/** 另存为：始终弹系统对话框，成功后把目标标签切到这个文件。 */
export function saveDocumentAs(
  source: SaveSource = "direct",
  reason: "direct" | "conflict" = "direct",
  target?: TabSession,
): Promise<boolean> {
  const tab = target ?? activeSession();
  if (tab.kind !== "doc") return Promise.resolve(false);
  return guardedSave(tab, source, () => runSaveAs(source, reason, tab));
}

async function runSaveAs(
  source: SaveSource,
  reason: "direct" | "conflict" = "direct",
  tab: TabSession,
): Promise<boolean> {
  const started = Date.now();
  try {
    const entries = saveEntries(tab);
    // 同 saveDocument：快照复用给体积估算与 zip，别重复全量序列化
    const snapshot = snapshotForSave(tab);
    const estimated = estimatedBytesOf(snapshot, entries);
    logInfo("save-as: start", {
      source,
      tab: tab.id,
      reason,
      suggested: suggestedName(tab),
      entries: entries.length,
      estimatedBytes: estimated,
    });
    if (!(await withinSaveLimit(estimated, source))) return false;
    await warnLargeSaveIfAny(estimated);
    const serializeStarted = Date.now();
    const bytes = await serializeDoc(snapshot, entries, await appVersionForManifest());
    logInfo("save-as: serialized", { source, tab: tab.id, bytes: bytes.length, ms: Date.now() - serializeStarted });
    if (bytes.length > MAX_SAVE_BYTES) {
      logWarn("save-as: over limit after zip", { source, bytes: bytes.length, limitBytes: MAX_SAVE_BYTES });
      await bridge.dialog.error(overLimitMessage());
      return false;
    }
    const result = await bridge.file.saveAs({ suggestedName: suggestedName(tab), bytes });
    logInfo("save-as: result", {
      source,
      tab: tab.id,
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
    tab.file.path = result.path;
    tab.file.name = result.name;
    return markSaved(tab, result.mtimeMs, source);
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

function markSaved(tab: TabSession, mtimeMs: number, source: SaveSource): boolean {
  tab.file.mtimeMs = mtimeMs;
  tab.file.externalChange = false;
  tab.file.missing = false;
  tab.file.ignoredMtime = null;
  tab.file.ignoredMissing = false;
  tab.store.markSaved();
  logInfo("save: marked saved", { source, tab: tab.id, mtimeMs });
  syncTitle();
  return true;
}

let lastDirty: boolean | null = null;
let lastName = "";
let lastActiveDirty: boolean | null = null;

/** 把脏状态与文件名同步给主进程（anyDirty 拦退出，active* 只影响窗口标题）。 */
export function syncTitle(): void {
  const active = ui.docOpen ? activeSession() : null;
  const name = active ? tabLabel(active) : "";
  const activeDirty = Boolean(active && active.store.isDirty);
  const anyDirty = docTabs().some((tab) => tab.store.isDirty);
  // 先写响应式状态（顶部胶囊读它），再决定要不要通知主进程
  fileState.dirty = activeDirty;
  if (anyDirty === lastDirty && name === lastName && activeDirty === lastActiveDirty) return;
  lastDirty = anyDirty;
  lastName = name;
  lastActiveDirty = activeDirty;
  logInfo("dirty changed", { anyDirty, name, activeDirty });
  bridge.app.setDirty({ anyDirty, activeName: name, activeDirty });
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

  // 外部改动：窗口重新获焦时补一次，切标签时也补一次（2s 防抖）；没有后台轮询
  if (typeof window.addEventListener === "function") {
    const onWindowFocus = () => scheduleExternalCheck(300);
    window.addEventListener("focus", onWindowFocus);
    disposers.push(() => window.removeEventListener("focus", onWindowFocus));
  }
  disposers.push(
    watch(
      () => sessionState.activeId,
      () => scheduleExternalCheck(200),
    ),
  );

  disposers.push(
    bridge.app.onCloseRequest(async ({ quit }) => {
      const dirtyTabs = docTabs().filter((tab) => tab.store.isDirty);
      if (import.meta.env.DEV) {
        console.info(`[close] request quit=${quit} dirty=${dirtyTabs.length} busy=${closeState.busy}`);
      }
      logInfo("close: request", { quit, dirty: dirtyTabs.length, busy: closeState.busy });
      if (closeState.busy) {
        logWarn("close: dropped, already busy", { quit });
        return;
      }
      closeState.busy = true;
      let closed = false;
      try {
        if (dirtyTabs.length === 0) {
          logInfo("close: clean, finish", { quit });
          bridge.app.finishClose(quit);
          closed = true;
          return;
        }
        // 活动标签上的进行中编辑先提交：否则"保存全部"会漏掉这几笔
        if (ui.docOpen) hooks.prepareTabSwitch();
        // 提交后脏集合可能变化（刚提交的文本编辑才算进文档）
        const dirty = docTabs().filter((tab) => tab.store.isDirty);
        const choice = await bridge.dialog.unsaved(dirty.map(tabLabel));
        logInfo("close: unsaved choice", { quit, count: dirty.length, choice });
        if (choice === "cancel") return;
        if (choice === "discard") {
          logInfo("close: discard", { quit, count: dirty.length });
          bridge.app.finishClose(quit);
          closed = true;
          return;
        }
        // 保存全部：按标签顺序逐个落盘，第一个失败就停（已保存的保持已保存）
        for (const tab of dirty) {
          if (!(await saveDocument("close", tab))) {
            logWarn("close: save failed, abort", { quit, tab: tab.id });
            await bridge.dialog.error(t("file.closeSaveError", { detail: tabLabel(tab) })).catch(() => undefined);
            return;
          }
        }
        bridge.app.finishClose(quit);
        closed = true;
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
  if (statTimer) {
    clearTimeout(statTimer);
    statTimer = null;
  }
  installed = false;
});
