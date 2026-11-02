/** 文件与对话框的 IPC 落地：只做"要对话框、搬字节、报结果"，不解析文件内容。 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import {
  CHANNELS,
  type AppLogEntry,
  type AppLogLevel,
  type OpenFileResult,
  type OverwriteChoice,
  type SaveAsRequest,
  type SaveAsResult,
  type SaveFileRequest,
  type SaveFileResult,
  type UnsavedChoice,
} from "../shared/ipc";
import { mtimeChanged, mtimeOf, readFileSnapshot, writeFileAtomic } from "./files";
import { basename, join } from "node:path";
import { logApp, logRenderer } from "./mcp/log";
import { flushPendingOpen, forgetRecentFile, listRecentFiles, requestOpen, touchRecentFile } from "./recent-state";

const FILTERS = [{ name: "Sqraft 设计文件", extensions: ["sqraft"] }];

function windowOf(sender: Electron.WebContents): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(sender) ?? undefined;
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
      ? await dialog.showOpenDialog(window, { properties: ["openFile"], filters: FILTERS })
      : await dialog.showOpenDialog({ properties: ["openFile"], filters: FILTERS });
    const path = result.filePaths[0];
    if (result.canceled || !path) {
      logApp("info", "file/open canceled", { ms: Date.now() - started });
      return { status: "canceled" };
    }
    try {
      const file = await readFileSnapshot(path);
      await touchRecentFile(path);
      logApp("info", "file/open ok", { path, bytes: file.bytes.length, ms: Date.now() - started });
      return { status: "ok", file };
    } catch (error) {
      logApp("error", "file/open failed", { path, error: messageOf(error), ms: Date.now() - started });
      return { status: "error", message: `无法读取文件：${messageOf(error)}` };
    }
  });

  ipcMain.handle(CHANNELS.fileOpenPath, async (_event, path: string): Promise<OpenFileResult> => {
    const started = Date.now();
    try {
      const file = await readFileSnapshot(path);
      await touchRecentFile(path);
      logApp("info", "file/open-path ok", { path, bytes: file.bytes.length, ms: Date.now() - started });
      return { status: "ok", file };
    } catch (error) {
      await forgetRecentFile(path);
      logApp("error", "file/open-path failed", { path, error: messageOf(error), ms: Date.now() - started });
      return { status: "error", message: `无法打开 ${basename(path)}：${messageOf(error)}` };
    }
  });

  ipcMain.handle(CHANNELS.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataPath: app.getPath("userData"),
  }));

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

  ipcMain.handle(CHANNELS.recentList, async () =>
    listRecentFiles().map((path) => ({ path, name: path.split(/[\\/]/).pop() ?? path })),
  );

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
      logApp("info", "file/save ok", { path: request.path, bytes: size, mtimeMs, ms: Date.now() - started });
      return { status: "ok", mtimeMs };
    } catch (error) {
      logApp("error", "file/save failed", {
        path: request.path,
        bytes: size,
        error: messageOf(error),
        ms: Date.now() - started,
      });
      return { status: "error", message: `保存失败：${messageOf(error)}` };
    }
  });

  ipcMain.handle(CHANNELS.fileSaveAs, async (event, request: SaveAsRequest): Promise<SaveAsResult> => {
    const window = windowOf(event.sender);
    const options = { defaultPath: request.suggestedName, filters: FILTERS };
    const started = Date.now();
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      logApp("info", "file/save-as canceled", { bytes: request.bytes?.length ?? 0, ms: Date.now() - started });
      return { status: "canceled" };
    }
    try {
      const mtimeMs = await writeFileAtomic(result.filePath, request.bytes);
      await touchRecentFile(result.filePath);
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
      return { status: "error", message: `保存失败：${messageOf(error)}` };
    }
  });

  ipcMain.handle(
    CHANNELS.fileExportPng,
    async (event, request: { suggestedName: string; bytes: Uint8Array }): Promise<SaveAsResult> => {
      const window = windowOf(event.sender);
      const options = {
        defaultPath: request.suggestedName,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      };
      const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { status: "canceled" };
      try {
        // 导出的是成品图，不参与"外部改动"检测，也不进最近文件
        await writeFileAtomic(result.filePath, request.bytes);
        logApp("info", "file/export-png ok", { path: result.filePath, bytes: request.bytes?.length ?? 0 });
        return { status: "ok", path: result.filePath, name: basename(result.filePath), mtimeMs: 0 };
      } catch (error) {
        logApp("error", "file/export-png failed", { path: result.filePath, error: messageOf(error) });
        return { status: "error", message: `导出失败：${messageOf(error)}` };
      }
    },
  );

  // 同一时刻只允许一个"未保存"框：渲染层若有多个监听（dev 热更新残留）同时请求，
  // 复用同一个结果，避免多个 sheet 叠在一起、用户被迫连点几次。
  ipcMain.handle(CHANNELS.dialogUnsaved, (event): Promise<UnsavedChoice> => {
    if (unsavedDialog) {
      if (!app.isPackaged) console.info("[close] 已有保存对话框，复用同一个结果");
      logApp("info", "dialog/unsaved reused");
      return unsavedDialog;
    }
    if (!app.isPackaged) console.info("[close] 打开保存对话框");
    logApp("info", "dialog/unsaved open");
    const window = windowOf(event.sender);
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["保存", "不保存", "取消"],
      defaultId: 0,
      cancelId: 2,
      message: "当前文档有未保存的改动",
      detail: "关闭前要保存吗？",
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
      buttons: ["覆盖", "另存为", "取消"],
      defaultId: 1,
      cancelId: 2,
      message: "文件已被外部修改",
      detail: "磁盘上的内容和你打开时不一样了。要覆盖它，还是另存为新文件？",
    };
    const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    const choice = (["overwrite", "save-as", "cancel"] as const)[result.response] ?? "cancel";
    logApp("info", "dialog/overwrite choice", { choice });
    return choice;
  });

  ipcMain.handle(CHANNELS.dialogError, async (event, message: string) => {
    const window = windowOf(event.sender);
    const options: Electron.MessageBoxOptions = { type: "error", buttons: ["知道了"], message };
    if (window) await dialog.showMessageBox(window, options);
    else await dialog.showMessageBox(options);
  });
}
