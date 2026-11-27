import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  CHANNELS,
  type AppInfo,
  type AppLogLevel,
  type CloseRequest,
  type ExportMatrixRequest,
  type ExportMatrixResult,
  type ExportSettings,
  type FetchImageResult,
  type FileStat,
  type LanguageState,
  type McpCallRequest,
  type MenuState,
  type McpCallResult,
  type McpClientsSnapshot,
  type McpClientsSyncEvent,
  type McpAttachResult,
  type McpSetupInfo,
  type McpStatus,
  type McpToolInfo,
  type OpenFileResult,
  type OverwriteChoice,
  type SaveAsRequest,
  type SaveAsResult,
  type SaveFileRequest,
  type SaveFileResult,
  type SqraftApi,
  type UnsavedChoice,
  type UpdateState,
} from "../shared/ipc";
import type { LanguagePreference, Locale } from "../shared/i18n";
import type { GradientValue } from "@sqraft/core";
import type { McpClientId } from "../shared/mcp-clients";
import type { CommandId } from "../shared/commands";

/**
 * 渲染层能接触到的全部主进程能力，只有这一处。
 * 全部通道在 shared/ipc 里显式声明；不暴露 ipcRenderer 本身。
 */
const api: SqraftApi = {
  platform: process.platform,
  file: {
    open: () => ipcRenderer.invoke(CHANNELS.fileOpen) as Promise<OpenFileResult>,
    openPath: (path: string) => ipcRenderer.invoke(CHANNELS.fileOpenPath, path) as Promise<OpenFileResult>,
    stat: (paths: string[]) => ipcRenderer.invoke(CHANNELS.fileStat, paths) as Promise<FileStat[]>,
    save: (request: SaveFileRequest) => ipcRenderer.invoke(CHANNELS.fileSave, request) as Promise<SaveFileResult>,
    saveAs: (request: SaveAsRequest) => ipcRenderer.invoke(CHANNELS.fileSaveAs, request) as Promise<SaveAsResult>,
    exportFile: (request: { suggestedName: string; bytes: Uint8Array; format: "png" | "svg" }) =>
      ipcRenderer.invoke(CHANNELS.fileExport, request) as Promise<SaveAsResult>,
    exportMatrix: (request: ExportMatrixRequest) =>
      ipcRenderer.invoke(CHANNELS.fileExportMatrix, request) as Promise<ExportMatrixResult>,
    exportSettings: () => ipcRenderer.invoke(CHANNELS.fileExportSettings) as Promise<ExportSettings>,
  },
  prefs: {
    gradientPresets: () => ipcRenderer.invoke(CHANNELS.prefsGradientPresets) as Promise<GradientValue[]>,
    setGradientPresets: (presets: GradientValue[]) =>
      ipcRenderer.invoke(CHANNELS.prefsSetGradientPresets, presets) as Promise<GradientValue[]>,
  },
  dialog: {
    unsaved: (names?: string[]) => ipcRenderer.invoke(CHANNELS.dialogUnsaved, names) as Promise<UnsavedChoice>,
    overwrite: () => ipcRenderer.invoke(CHANNELS.dialogOverwrite) as Promise<OverwriteChoice>,
    error: (message: string) => ipcRenderer.invoke(CHANNELS.dialogError, message) as Promise<void>,
  },
  mcp: {
    onCall: (handler: (request: McpCallRequest) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: McpCallRequest) => handler(request);
      ipcRenderer.on(CHANNELS.mcpCall, listener);
      return () => ipcRenderer.removeListener(CHANNELS.mcpCall, listener);
    },
    respond: (result: McpCallResult) => ipcRenderer.send(CHANNELS.mcpRespond, result),
    setTools: (tools: McpToolInfo[]) => ipcRenderer.send(CHANNELS.mcpSetTools, tools),
    setup: () => ipcRenderer.invoke(CHANNELS.mcpSetup) as Promise<McpSetupInfo>,
    setPort: (port: number | null) => ipcRenderer.invoke(CHANNELS.mcpSetPort, port) as Promise<McpSetupInfo>,
    clients: () => ipcRenderer.invoke(CHANNELS.mcpClients) as Promise<McpClientsSnapshot>,
    attachClient: (id: McpClientId) => ipcRenderer.invoke(CHANNELS.mcpClientsAttach, id) as Promise<McpAttachResult>,
    detachClient: (id: McpClientId) => ipcRenderer.invoke(CHANNELS.mcpClientsDetach, id) as Promise<McpAttachResult>,
    replaceClient: (id: McpClientId) => ipcRenderer.invoke(CHANNELS.mcpClientsReplace, id) as Promise<McpAttachResult>,
    onClientsSynced: (handler: (event: McpClientsSyncEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, next: McpClientsSyncEvent) => handler(next);
      ipcRenderer.on(CHANNELS.mcpClientsSynced, listener);
      return () => ipcRenderer.removeListener(CHANNELS.mcpClientsSynced, listener);
    },
    onStatus: (handler: (status: McpStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: McpStatus) => handler(status);
      ipcRenderer.on(CHANNELS.mcpStatus, listener);
      return () => ipcRenderer.removeListener(CHANNELS.mcpStatus, listener);
    },
    status: () => ipcRenderer.invoke(CHANNELS.mcpStatusQuery) as Promise<McpStatus>,
  },
  recent: {
    list: () => ipcRenderer.invoke(CHANNELS.recentList) as Promise<{ path: string; name: string }[]>,
  },
  update: {
    state: () => ipcRenderer.invoke(CHANNELS.updateState) as Promise<UpdateState>,
    check: (manual?: boolean) => ipcRenderer.invoke(CHANNELS.updateCheck, manual === true) as Promise<UpdateState>,
    restart: () => ipcRenderer.invoke(CHANNELS.updateRestart) as Promise<void>,
    download: () => ipcRenderer.invoke(CHANNELS.updateDownload) as Promise<boolean>,
    setAutoDownload: (enabled: boolean) =>
      ipcRenderer.invoke(CHANNELS.updateSetAutoDownload, enabled === true) as Promise<UpdateState>,
    onState: (handler: (state: UpdateState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, next: UpdateState) => handler(next);
      ipcRenderer.on(CHANNELS.updateChanged, listener);
      return () => ipcRenderer.removeListener(CHANNELS.updateChanged, listener);
    },
  },
  menu: {
    onCommand: (handler: (action: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, action: string) => handler(action);
      ipcRenderer.on(CHANNELS.menuCommand, listener);
      return () => ipcRenderer.removeListener(CHANNELS.menuCommand, listener);
    },
    setBindings: (bindings: Record<string, string>) => ipcRenderer.send(CHANNELS.menuSetBindings, bindings),
    setState: (state: MenuState) => ipcRenderer.send(CHANNELS.menuSetState, state),
  },
  app: {
    info: () => ipcRenderer.invoke(CHANNELS.appInfo) as Promise<AppInfo>,
    runCommand: (id: CommandId) => ipcRenderer.invoke(CHANNELS.appRunCommand, id) as Promise<boolean>,
    setLanguage: (preference: LanguagePreference) =>
      ipcRenderer.invoke(CHANNELS.appSetLanguage, preference) as Promise<LanguageState>,
    onLanguageChange: (handler: (locale: Locale) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, locale: Locale) => handler(locale);
      ipcRenderer.on(CHANNELS.appLanguageChanged, listener);
      return () => ipcRenderer.removeListener(CHANNELS.appLanguageChanged, listener);
    },
    showLicenses: () => ipcRenderer.invoke(CHANNELS.appShowLicenses) as Promise<void>,
    copyText: (text: string) => ipcRenderer.send(CHANNELS.appCopyText, text),
    readClipboardImage: () => ipcRenderer.invoke(CHANNELS.appClipboardImage) as Promise<Uint8Array | null>,
    fetchImage: (url: string, options?: { force?: boolean }) =>
      ipcRenderer.invoke(CHANNELS.appFetchImage, url, options) as Promise<FetchImageResult>,
    clearImageCache: () => ipcRenderer.invoke(CHANNELS.appClearImageCache) as Promise<{ bytes: number }>,
    writeClipboardImage: (dataUrl: string) =>
      ipcRenderer.invoke(CHANNELS.appClipboardImageWrite, dataUrl) as Promise<boolean>,
    writeClipboardNodes: (json: string) =>
      ipcRenderer.invoke(CHANNELS.appClipboardNodesWrite, json) as Promise<void>,
    readClipboardNodes: () => ipcRenderer.invoke(CHANNELS.appClipboardNodesRead) as Promise<string | null>,
    readClipboardText: () => ipcRenderer.invoke(CHANNELS.appClipboardText) as Promise<string>,
    signalReady: () => ipcRenderer.send(CHANNELS.appRendererReady),
    onOpenRequest: (handler: (path: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, path: string) => handler(path);
      ipcRenderer.on(CHANNELS.fileOpenRequest, listener);
      return () => ipcRenderer.removeListener(CHANNELS.fileOpenRequest, listener);
    },
    setDirty: (state: { anyDirty: boolean; activeName: string; activeDirty: boolean }) =>
      ipcRenderer.send(CHANNELS.appSetDirty, state),
    log: (level: AppLogLevel, event: string, fields?: Record<string, unknown>) =>
      ipcRenderer.send(CHANNELS.appLog, { level, event, fields }),
    onCloseRequest: (handler: (request: CloseRequest) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: CloseRequest) => handler(request);
      ipcRenderer.on(CHANNELS.appRequestClose, listener);
      return () => ipcRenderer.removeListener(CHANNELS.appRequestClose, listener);
    },
    finishClose: (quit: boolean) => ipcRenderer.send(CHANNELS.appFinishClose, { quit }),
    cancelClose: () => ipcRenderer.send(CHANNELS.appCancelClose),
    closeWindow: () => ipcRenderer.send(CHANNELS.appCloseWindow),
    revealPath: (path: string) => ipcRenderer.invoke(CHANNELS.appRevealPath, path) as Promise<void>,
  },
};

contextBridge.exposeInMainWorld("sqraft", api);

/**
 * 拖拽打开：File 对象只在 preload 侧解析成本地路径（webUtils），
 * 不把 File 跨 contextBridge 传，也不让渲染层接触文件系统。
 */
window.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    const path = webUtils.getPathForFile(file);
    // 只有 .sqraft 交给主进程打开；图片等其它文件留给渲染层自己处理
    if (path && path.toLowerCase().endsWith(".sqraft")) ipcRenderer.send(CHANNELS.fileDropped, path);
  });
});
