/**
 * 最近打开与应用级"请求打开某个文件"的中转。
 * 打开请求可能来自：最近菜单、拖拽、双击文件（open-file）、第二实例的命令行参数。
 */
import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { CHANNELS } from "../shared/ipc";
import {
  addRecent,
  loadPreferences,
  removeRecent,
  savePreferences,
  type McpPreferences,
  type Preferences,
  type UpdatePreferences,
  type WindowBounds,
} from "./preferences";
import { setRecentFiles } from "./menu";

let recent: string[] = [];
let preferences: Preferences = { recentFiles: [] };
let pendingPath: string | null = null;

function preferencesFile(): string {
  return join(app.getPath("userData"), "preferences.json");
}

export async function initRecentFiles(): Promise<void> {
  preferences = await loadPreferences(preferencesFile());
  recent = preferences.recentFiles;
  setRecentFiles(recent);
}

export function currentPreferences(): Preferences {
  return preferences;
}

/**
 * 更新 MCP 端口偏好：`null` 表示删除该字段。
 * 显式端口与自动模式记住的端口分开存，互不覆盖。
 */
export async function updateMcpPreferences(patch: {
  port?: number | null;
  autoPort?: number | null;
}): Promise<void> {
  const next: McpPreferences = { ...(preferences.mcp ?? {}) };
  if (patch.port === null) delete next.port;
  else if (patch.port !== undefined) next.port = patch.port;
  if (patch.autoPort === null) delete next.autoPort;
  else if (patch.autoPort !== undefined) next.autoPort = patch.autoPort;
  preferences = { ...preferences, mcp: next };
  await savePreferences(preferencesFile(), preferences);
}

export async function saveWindowBounds(bounds: WindowBounds): Promise<void> {
  preferences = { ...preferences, window: bounds };
  await savePreferences(preferencesFile(), preferences);
}

/** 更新状态偏好：字段传 `undefined` 表示删除该字段。 */
export function updatePreferences(): UpdatePreferences {
  return { ...(preferences.update ?? {}) };
}

export async function patchUpdatePreferences(patch: Partial<UpdatePreferences>): Promise<void> {
  const next: UpdatePreferences = { ...(preferences.update ?? {}) };
  for (const key of Object.keys(patch) as (keyof UpdatePreferences)[]) {
    const value = patch[key];
    if (value === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  preferences = { ...preferences, update: next };
  await savePreferences(preferencesFile(), preferences);
}

export function listRecentFiles(): string[] {
  return recent;
}

/** 记录一次成功打开/保存的路径：置顶、去重、截断，并写盘。 */
export async function touchRecentFile(path: string): Promise<void> {
  recent = addRecent(recent, path);
  setRecentFiles(recent);
  if (process.platform === "darwin") app.addRecentDocument(path);
  preferences = { ...preferences, recentFiles: recent };
  await savePreferences(preferencesFile(), preferences);
}

/** 从最近列表剔除（文件已被删除/移动时自愈）。 */
export async function forgetRecentFile(path: string): Promise<void> {
  recent = removeRecent(recent, path);
  setRecentFiles(recent);
  preferences = { ...preferences, recentFiles: recent };
  await savePreferences(preferencesFile(), preferences);
}

/** 让当前窗口打开某个文件；窗口还没建好时先缓存，加载完成后再发。 */
export function requestOpen(path: string): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window || window.webContents.isLoading()) {
    pendingPath = path;
    return;
  }
  window.webContents.send(CHANNELS.fileOpenRequest, path);
}

/** 窗口加载完成后补发第一个请求（双击文件启动时常见）。 */
export function flushPendingOpen(): void {
  if (!pendingPath) return;
  const path = pendingPath;
  pendingPath = null;
  requestOpen(path);
}
