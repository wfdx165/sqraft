/** 文件与对话框的 IPC 落地：只做"要对话框、搬字节、报结果"，不解析文件内容。 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import {
  CHANNELS,
  type AppLogEntry,
  type AppLogLevel,
  type ExportMatrixRequest,
  type ExportMatrixResult,
  type ExportSettings,
  type FileStat,
  type OpenFileResult,
  type OverwriteChoice,
  type RecentThumbnailRequest,
  type SaveAsRequest,
  type SaveAsResult,
  type SaveFileRequest,
  type SaveFileResult,
  type UnsavedChoice,
} from "../shared/ipc";
import { mtimeChanged, mtimeOf, samePath, writeFileAtomic } from "./files";
import { stageDocument } from "./doc-stream";
import { basename, dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import { logApp, logRenderer } from "./mcp/log";
import {
  THUMBNAIL_DIR,
  pruneThumbnails,
  recentEntries,
  writeThumbnail,
} from "./thumbnails";
import {
  exportPreferences,
  gradientPresetPreferences,
  setGradientPresetPreferences,
  clearRecentFiles,
  flushPendingOpen,
  forgetRecentFile,
  listRecentFiles,
  patchExportPreferences,
  requestOpen,
  touchRecentFile,
  updateLanguagePreference,
} from "./recent-state";
import { getLanguagePreference, getLocale, setMainLanguage, t } from "./i18n";
import { isLanguagePreference } from "../shared/i18n";
import { normalizeExportSettings } from "./preferences";
import { rebuildMenu } from "./menu";

const SQRAFT_FILTER = () => [{ name: t("fileFilter.sqraft"), extensions: ["sqraft"] }];

function windowOf(sender: Electron.WebContents): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(sender) ?? undefined;
}

/** 封面缓存目录：userData/thumbnails（与链接图的 image-cache 分开）。 */
function thumbnailDir(): string {
  return join(app.getPath("userData"), THUMBNAIL_DIR);
}

/** 写封面失败不能影响保存：只记一行日志。 */
async function rememberThumbnail(path: string, mtimeMs: number, bytes: Uint8Array | undefined): Promise<void> {
  if (!bytes || bytes.length === 0) return;
  try {
    await writeThumbnail(thumbnailDir(), path, mtimeMs, bytes);
    await pruneThumbnails(thumbnailDir(), listRecentFiles());
  } catch (error) {
    logApp("warn", "thumbnail write failed", { path, error: messageOf(error) });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 正在进行中的"未保存"对话框（并发请求共享同一个结果） */
let unsavedDialog: Promise<UnsavedChoice> | null = null;

function isLogLevel(value: unknown): value is AppLogLevel {
  return value === "info" || value === "warn" || value === "error";
}

export function registerFileChannels(): void {
  // 渲染层日志：只接受"事件 + 字段"，格式与落盘全在主进程
  ipcMain.on(CHANNELS.appLog, (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const { level, event, fields } = raw as Partial<AppLogEntry>;
    if (!isLogLevel(level) || typeof event !== "string" || !event) return;
    logRenderer(level, event, fields && typeof fields === "object" ? fields : undefined);
  });

  ipcMain.handle(CHANNELS.fileOpen, async (event): Promise<OpenFileResult> => {
    const window = windowOf(event.sender);
    const started = Date.now();
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ["openFile"], filters: SQRAFT_FILTER() })
      : await dialog.showOpenDialog({ properties: ["openFile"], filters: SQRAFT_FILTER() });
    const path = result.filePaths[0];
    if (result.canceled || !path) {
      logApp("info", "file/open canceled", { ms: Date.now() - started });
      return { status: "canceled" };
    }
    try {
      const file = await stageDocument(path);
      await touchRecentFile(path);
      logApp("info", "file/open ok", { path, bytes: file.size, ms: Date.now() - started });
      return { status: "ok", file };
    } catch (error) {
      logApp("error", "file/open failed", { path, error: messageOf(error), ms: Date.now() - started });
      return { status: "error", message: t("error.readFile", { detail: messageOf(error) }) };
    }
  });

  // 外部改动检测：只 stat，不读内容；单个失败按"不存在"回报，不整体失败
  ipcMain.handle(CHANNELS.fileStat, async (_event, rawPaths: unknown): Promise<FileStat[]> => {
    const paths = Array.isArray(rawPaths) ? rawPaths.filter((path): path is string => typeof path === "string") : [];
    return Promise.all(
      paths.map(async (path) => {
        try {
          const info = await stat(path);
          return { path, exists: true, mtimeMs: info.mtimeMs };
        } catch {
          return { path, exists: false, mtimeMs: 0 };
        }
      }),
    );
  });

  ipcMain.handle(CHANNELS.fileOpenPath, async (_event, path: string): Promise<OpenFileResult> => {
    const started = Date.now();
    try {
      const file = await stageDocument(path);
      await touchRecentFile(path);
      logApp("info", "file/open-path ok", { path, bytes: file.size, ms: Date.now() - started });
      return { status: "ok", file };
    } catch (error) {
      await forgetRecentFile(path);
      logApp("error", "file/open-path failed", { path, error: messageOf(error), ms: Date.now() - started });
      return { status: "error", message: t("error.openFile", { name: basename(path), detail: messageOf(error) }) };
    }
  });

  ipcMain.handle(CHANNELS.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataPath: app.getPath("userData"),
    language: getLanguagePreference(),
    locale: getLocale(),
  }));

  ipcMain.handle(CHANNELS.appSetLanguage, async (_event, raw: unknown) => {
    if (!isLanguagePreference(raw)) throw new Error("invalid language preference");
    await updateLanguagePreference(raw);
    const locale = setMainLanguage(raw);
    rebuildMenu();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CHANNELS.appLanguageChanged, locale);
    }
    return { language: raw, locale };
  });

  // 许可文本随包分发（extraResources → Resources/licenses/）；dev 下没有这段资源，退回
  // electron 自带 dist 目录（里面同样有 LICENSE 与 LICENSES.chromium.html）
  ipcMain.handle(CHANNELS.appShowLicenses, async () => {
    const licenses = app.isPackaged
      ? join(process.resourcesPath, "licenses")
      : join(app.getAppPath(), "node_modules/electron/dist");
    try {
      await shell.openPath(licenses);
    } catch (error) {
      logApp("warn", "licenses open failed", { licenses, error: messageOf(error) });
    }
  });

  ipcMain.on(CHANNELS.appRendererReady, () => {
    logApp("info", "renderer ready");
    flushPendingOpen();
  });

  // Home 上的 ⌘W：关窗口仍由 close-guard 拦（有未保存改动时先问渲染层）
  ipcMain.on(CHANNELS.appCloseWindow, () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    logApp("info", "close window requested");
    win?.close();
  });

  ipcMain.handle(CHANNELS.appRevealPath, async (_event, path: unknown) => {
    if (typeof path !== "string" || !path) return;
    shell.showItemInFolder(path);
  });

  ipcMain.handle(CHANNELS.recentList, async () => recentEntries(thumbnailDir(), listRecentFiles()));

  ipcMain.handle(
    CHANNELS.recentThumbnail,
    async (_event, request: RecentThumbnailRequest): Promise<void> => {
      if (!request || typeof request.path !== "string" || !request.path) return;
      if (typeof request.mtimeMs !== "number" || !Number.isFinite(request.mtimeMs)) return;
      await rememberThumbnail(request.path, request.mtimeMs, request.bytes);
    },
  );

  ipcMain.handle(CHANNELS.recentClear, async (): Promise<void> => {
    const before = listRecentFiles().length;
    await clearRecentFiles();
    // 列表空了，封面也没有归属：一并删掉，别在 userData 里留孤儿
    await pruneThumbnails(thumbnailDir(), []).catch(() => undefined);
    logApp("info", "recent clear", { removed: before });
  });

  ipcMain.on(CHANNELS.fileDropped, (_event, path: string) => {
    if (typeof path === "string" && path) {
      logApp("info", "file dropped", { path });
      requestOpen(path);
    }
  });

  ipcMain.handle(CHANNELS.fileSave, async (_event, request: SaveFileRequest): Promise<SaveFileResult> => {
    const started = Date.now();
    const size = request.bytes?.length ?? 0;
    try {
      const current = await mtimeOf(request.path);
      if (mtimeChanged(request.expectedMtimeMs, current)) {
        logApp("warn", "file/save conflict", {
          path: request.path,
          expectedMtimeMs: request.expectedMtimeMs,
          currentMtimeMs: current,
          bytes: size,
          ms: Date.now() - started,
        });
        return { status: "conflict", mtimeMs: current ?? 0 };
      }
      const mtimeMs = await writeFileAtomic(request.path, request.bytes);
      await rememberThumbnail(request.path, mtimeMs, request.thumbnail);
      logApp("info", "file/save ok", { path: request.path, bytes: size, mtimeMs, ms: Date.now() - started });
      return { status: "ok", mtimeMs };
    } catch (error) {
      logApp("error", "file/save failed", {
        path: request.path,
        bytes: size,
        error: messageOf(error),
        ms: Date.now() - started,
      });
      return { status: "error", message: t("error.saveFile", { detail: messageOf(error) }) };
    }
  });

  ipcMain.handle(CHANNELS.fileSaveAs, async (event, request: SaveAsRequest): Promise<SaveAsResult> => {
    const window = windowOf(event.sender);
    const options = { defaultPath: request.suggestedName, filters: SQRAFT_FILTER() };
    const started = Date.now();
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      logApp("info", "file/save-as canceled", { bytes: request.bytes?.length ?? 0, ms: Date.now() - started });
      return { status: "canceled" };
    }
    try {
      // 另存为可能选到另一个标签已经在编辑的文件：两边各有撤销栈，后保存的会覆盖前一个。
      // 在写盘之前拦住，文件保持原样，让用户换个名字或先关掉那个标签。
      const otherPaths = Array.isArray(request.otherPaths)
        ? request.otherPaths.filter((path): path is string => typeof path === "string" && path.length > 0)
        : [];
      if (otherPaths.some((path) => samePath(path, result.filePath))) {
        logApp("warn", "file/save-as already open", { path: result.filePath, others: otherPaths.length });
        return { status: "conflict", path: result.filePath, name: basename(result.filePath) };
      }
      const mtimeMs = await writeFileAtomic(result.filePath, request.bytes);
      await touchRecentFile(result.filePath);
      await rememberThumbnail(result.filePath, mtimeMs, request.thumbnail);
      logApp("info", "file/save-as ok", {
        path: result.filePath,
        bytes: request.bytes?.length ?? 0,
        mtimeMs,
        ms: Date.now() - started,
      });
      return { status: "ok", path: result.filePath, name: basename(result.filePath), mtimeMs };
    } catch (error) {
      logApp("error", "file/save-as failed", {
        path: result.filePath,
        error: messageOf(error),
        ms: Date.now() - started,
      });
      return { status: "error", message: t("error.saveFile", { detail: messageOf(error) }) };
    }
  });

  ipcMain.handle(
    CHANNELS.fileExport,
    async (event, request: { suggestedName: string; bytes: Uint8Array; format: "png" | "svg" }): Promise<SaveAsResult> => {
      const window = windowOf(event.sender);
      const format = request.format === "svg" ? "svg" : "png";
      const options = {
        defaultPath: request.suggestedName,
        filters: [
          format === "svg"
            ? { name: t("fileFilter.svg"), extensions: ["svg"] }
            : { name: t("fileFilter.png"), extensions: ["png"] },
        ],
      };
      const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { status: "canceled" };
      try {
        // 导出的是成品图，不参与"外部改动"检测，也不进最近文件
        await writeFileAtomic(result.filePath, request.bytes);
        logApp("info", "file/export ok", { path: result.filePath, bytes: request.bytes?.length ?? 0 });
        return { status: "ok", path: result.filePath, name: basename(result.filePath), mtimeMs: 0 };
      } catch (error) {
        logApp("error", "file/export failed", { path: result.filePath, error: messageOf(error) });
        return { status: "error", message: t("error.exportFile", { detail: messageOf(error) }) };
      }
    },
  );

  ipcMain.handle(CHANNELS.fileExportSettings, (): ExportSettings => exportPreferences());

  // 渐变预设：渲染层已验证过语义，这里只夹上限并写 preferences.json
  ipcMain.handle(CHANNELS.prefsGradientPresets, () => gradientPresetPreferences());
  ipcMain.handle(CHANNELS.prefsSetGradientPresets, (_event, list: unknown) => setGradientPresetPreferences(list));

  // 多倍率导出：渲染层已打成 zip，这里只选一次保存位置、一次原子写
  ipcMain.handle(
    CHANNELS.fileExportMatrix,
    async (event, request: ExportMatrixRequest): Promise<ExportMatrixResult> => {
      const window = windowOf(event.sender);
      const bytes = request?.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        return { status: "error", message: t("error.exportFile", { detail: t("exportMatrix.empty") }) };
      }
      const settings = normalizeExportSettings(request?.settings);
      const suggested =
        typeof request?.suggestedName === "string" && request.suggestedName.trim()
          ? basename(request.suggestedName.trim())
          : `${t("common.untitled")}.zip`;
      const options: Electron.SaveDialogOptions = {
        title: t("exportMatrix.chooseZip"),
        buttonLabel: t("exportMatrix.saveZip"),
        defaultPath: settings.directory ? join(settings.directory, suggested) : suggested,
        filters: [{ name: t("fileFilter.zip"), extensions: ["zip"] }],
      };
      const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { status: "canceled" };
      // 用户手输的名字可能没带扩展名：补上，避免存成无后缀文件
      const path = /\.zip$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.zip`;
      try {
        await writeFileAtomic(path, bytes);
        const directory = dirname(path);
        await patchExportPreferences({ ...settings, directory }).catch((error: unknown) => {
          logApp("warn", "file/export matrix prefs failed", { error: messageOf(error) });
        });
        const count = typeof request?.count === "number" && request.count > 0 ? request.count : 0;
        logApp("info", "file/export matrix ok", { path, count, bytes: bytes.length });
        return { status: "ok", count, path, name: basename(path) };
      } catch (error) {
        logApp("error", "file/export matrix failed", { path, error: messageOf(error) });
        return { status: "error", message: t("error.exportFile", { detail: messageOf(error) }) };
      }
    },
  );

  // 同一时刻只允许一个"未保存"框：渲染层若有多个监听（dev 热更新残留）同时请求，
  // 复用同一个结果，避免多个 sheet 叠在一起、用户被迫连点几次。
  ipcMain.handle(CHANNELS.dialogUnsaved, (event, rawNames: unknown): Promise<UnsavedChoice> => {
    const names = Array.isArray(rawNames)
      ? rawNames.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      : [];
    const many = names.length > 1;
    if (unsavedDialog) {
      if (!app.isPackaged) console.info("[close] 已有保存对话框，复用同一个结果");
      logApp("info", "dialog/unsaved reused", { names: names.length });
      return unsavedDialog;
    }
    if (!app.isPackaged) console.info("[close] 打开保存对话框");
    logApp("info", "dialog/unsaved open", { names: names.length });
    const window = windowOf(event.sender);
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: many
        ? [t("dialog.saveAll"), t("dialog.dontSaveAll"), t("common.cancel")]
        : [t("common.save"), t("common.dontSave"), t("common.cancel")],
      defaultId: 0,
      cancelId: 2,
      message: many
        ? t("dialog.unsavedMany", { count: names.length })
        : names.length === 1
          ? t("dialog.unsavedOne", { name: names[0]! })
          : t("dialog.unsavedMessage"),
      detail: many ? `${t("dialog.unsavedManyDetail")}\n\n${names.join("\n")}` : t("dialog.unsavedDetail"),
    };
    unsavedDialog = (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
      .then((result) => {
        const choice = (["save", "discard", "cancel"] as const)[result.response] ?? "cancel";
        logApp("info", "dialog/unsaved choice", { choice });
        return choice;
      })
      .finally(() => {
        unsavedDialog = null;
      });
    return unsavedDialog;
  });

  ipcMain.handle(CHANNELS.dialogOverwrite, async (event): Promise<OverwriteChoice> => {
    const window = windowOf(event.sender);
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: [t("dialog.overwrite"), t("dialog.saveAs"), t("common.cancel")],
      defaultId: 1,
      cancelId: 2,
      message: t("dialog.overwriteMessage"),
      detail: t("dialog.overwriteDetail"),
    };
    const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    const choice = (["overwrite", "save-as", "cancel"] as const)[result.response] ?? "cancel";
    logApp("info", "dialog/overwrite choice", { choice });
    return choice;
  });

  ipcMain.handle(CHANNELS.dialogError, async (event, message: string) => {
    const window = windowOf(event.sender);
    const options: Electron.MessageBoxOptions = { type: "error", buttons: [t("common.ok")], message };
    if (window) await dialog.showMessageBox(window, options);
    else await dialog.showMessageBox(options);
  });
}
