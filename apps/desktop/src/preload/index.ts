import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  CHANNELS,
  type AppInfo,
  type CloseRequest,
  type McpCallRequest,
  type McpCallResult,
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
} from "../shared/ipc";

/**
 * 渲染层能接触到的全部主进程能力，只有这一处。
 * 全部通道在 shared/ipc 里显式声明；不暴露 ipcRenderer 本身。
 */
const api: SqraftApi = {
  platform: process.platform,
  file: {
    open: () => ipcRenderer.invoke(CHANNELS.fileOpen) as Promise<OpenFileResult>,
    openPath: (path: string) => ipcRenderer.invoke(CHANNELS.fileOpenPath, path) as Promise<OpenFileResult>,
    save: (request: SaveFileRequest) => ipcRenderer.invoke(CHANNELS.fileSave, request) as Promise<SaveFileResult>,
    saveAs: (request: SaveAsRequest) => ipcRenderer.invoke(CHANNELS.fileSaveAs, request) as Promise<SaveAsResult>,
    exportPng: (request: { suggestedName: string; bytes: Uint8Array }) =>
      ipcRenderer.invoke(CHANNELS.fileExportPng, request) as Promise<SaveAsResult>,
  },
  dialog: {
    unsaved: () => ipcRenderer.invoke(CHANNELS.dialogUnsaved) as Promise<UnsavedChoice>,
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
  menu: {
    onCommand: (handler: (action: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, action: string) => handler(action);
      ipcRenderer.on(CHANNELS.menuCommand, listener);
      return () => ipcRenderer.removeListener(CHANNELS.menuCommand, listener);
    },
    setBindings: (bindings: Record<string, string>) => ipcRenderer.send(CHANNELS.menuSetBindings, bindings),
  },
  app: {
    info: () => ipcRenderer.invoke(CHANNELS.appInfo) as Promise<AppInfo>,
    copyText: (text: string) => ipcRenderer.send(CHANNELS.appCopyText, text),
    readClipboardImage: () => ipcRenderer.invoke(CHANNELS.appClipboardImage) as Promise<Uint8Array | null>,
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
    setDirty: (dirty: boolean, name: string) => ipcRenderer.send(CHANNELS.appSetDirty, { dirty, name }),
    onCloseRequest: (handler: (request: CloseRequest) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: CloseRequest) => handler(request);
      ipcRenderer.on(CHANNELS.appRequestClose, listener);
      return () => ipcRenderer.removeListener(CHANNELS.appRequestClose, listener);
    },
    finishClose: (quit: boolean) => ipcRenderer.send(CHANNELS.appFinishClose, { quit }),
    cancelClose: () => ipcRenderer.send(CHANNELS.appCancelClose),
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
