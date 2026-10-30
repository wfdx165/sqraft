/** 文件与对话框的 IPC 落地：只做"要对话框、搬字节、报结果"，不解析文件内容。 */
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
  CHANNELS,
  type OpenFileResult,
  type OverwriteChoice,
  type SaveAsRequest,
  type SaveAsResult,
  type SaveFileRequest,
  type SaveFileResult,
  type UnsavedChoice,
} from "../shared/ipc";
import { mtimeChanged, mtimeOf, readFileSnapshot, writeFileAtomic } from "./files";
import { basename } from "node:path";
import { flushPendingOpen, forgetRecentFile, listRecentFiles, requestOpen, touchRecentFile } from "./recent-state";

const FILTERS = [{ name: "Sqraft 设计文件", extensions: ["sqraft"] }];

function windowOf(sender: Electron.WebContents): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(sender) ?? undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let newDocumentOnReady = false;

/** MCP 自动拉起时用：渲染层就绪后跳过欢迎页，直接建空稿。 */
export function requestNewDocumentOnReady(): void {
  newDocumentOnReady = true;
}

export function registerFileChannels(): void {
  ipcMain.handle(CHANNELS.fileOpen, async (event): Promise<OpenFileResult> => {
    const window = windowOf(event.sender);
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ["openFile"], filters: FILTERS })
      : await dialog.showOpenDialog({ properties: ["openFile"], filters: FILTERS });
    const path = result.filePaths[0];
    if (result.canceled || !path) return { status: "canceled" };
    try {
      const file = await readFileSnapshot(path);
      await touchRecentFile(path);
      return { status: "ok", file };
    } catch (error) {
      return { status: "error", message: `无法读取文件：${messageOf(error)}` };
    }
  });

  ipcMain.handle(CHANNELS.fileOpenPath, async (_event, path: string): Promise<OpenFileResult> => {
    try {
      const file = await readFileSnapshot(path);
      await touchRecentFile(path);
      return { status: "ok", file };
    } catch (error) {
      await forgetRecentFile(path);
      return { status: "error", message: `无法打开 ${basename(path)}：${messageOf(error)}` };
    }
  });

  ipcMain.handle(CHANNELS.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    dataPath: app.getPath("userData"),
  }));

  ipcMain.on(CHANNELS.appRendererReady, (event) => {
    flushPendingOpen();
    if (newDocumentOnReady) {
      newDocumentOnReady = false;
      event.sender.send(CHANNELS.appNewDocument);
    }
  });

  ipcMain.handle(CHANNELS.recentList, async () =>
    listRecentFiles().map((path) => ({ path, name: path.split(/[\\/]/).pop() ?? path })),
  );

  ipcMain.on(CHANNELS.fileDropped, (_event, path: string) => {
    if (typeof path === "string" && path) requestOpen(path);
  });

  ipcMain.handle(CHANNELS.fileSave, async (_event, request: SaveFileRequest): Promise<SaveFileResult> => {
    try {
      const current = await mtimeOf(request.path);
      if (mtimeChanged(request.expectedMtimeMs, current)) {
        return { status: "conflict", mtimeMs: current ?? 0 };
      }
      return { status: "ok", mtimeMs: await writeFileAtomic(request.path, request.bytes) };
    } catch (error) {
      return { status: "error", message: `保存失败：${messageOf(error)}` };
    }
  });

  ipcMain.handle(CHANNELS.fileSaveAs, async (event, request: SaveAsRequest): Promise<SaveAsResult> => {
    const window = windowOf(event.sender);
    const options = { defaultPath: request.suggestedName, filters: FILTERS };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { status: "canceled" };
    try {
      const mtimeMs = await writeFileAtomic(result.filePath, request.bytes);
      await touchRecentFile(result.filePath);
      return { status: "ok", path: result.filePath, name: basename(result.filePath), mtimeMs };
    } catch (error) {
      return { status: "error", message: `保存失败：${messageOf(error)}` };
    }
  });

  ipcMain.handle(CHANNELS.dialogUnsaved, async (event): Promise<UnsavedChoice> => {
    const window = windowOf(event.sender);
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["保存", "不保存", "取消"],
      defaultId: 0,
      cancelId: 2,
      message: "当前文档有未保存的改动",
      detail: "关闭前要保存吗？",
    };
    const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return (["save", "discard", "cancel"] as const)[result.response] ?? "cancel";
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
    return (["overwrite", "save-as", "cancel"] as const)[result.response] ?? "cancel";
  });

  ipcMain.handle(CHANNELS.dialogError, async (event, message: string) => {
    const window = windowOf(event.sender);
    const options: Electron.MessageBoxOptions = { type: "error", buttons: ["知道了"], message };
    if (window) await dialog.showMessageBox(window, options);
    else await dialog.showMessageBox(options);
  });
}
