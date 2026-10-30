/**
 * 应用偏好（`userData/preferences.json`）：目前只有最近打开列表。
 * 纯函数 + 显式路径，测试只需临时目录，不依赖 Electron。
 */
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./files";

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface Preferences {
  recentFiles: string[];
  window?: WindowBounds;
}

const MAX_RECENT = 8;

export const DEFAULT_PREFERENCES: Preferences = { recentFiles: [] };

/** 最近列表：去重、置顶、截断；不存在的路径也会先保留，打开失败时再剔除。 */
export function addRecent(list: readonly string[], path: string, max = MAX_RECENT): string[] {
  const next = [path, ...list.filter((item) => item !== path)];
  return next.slice(0, max);
}

export function removeRecent(list: readonly string[], path: string): string[] {
  return list.filter((item) => item !== path);
}

/** 读取偏好；文件缺失、损坏、形状不对时回退默认值而不是崩溃。 */
export async function loadPreferences(file: string): Promise<Preferences> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PREFERENCES };
    const record = parsed as { recentFiles?: unknown; window?: unknown };
    const recent = record.recentFiles;
    const recentFiles = Array.isArray(recent) ? recent.filter((item): item is string => typeof item === "string") : [];
    return { recentFiles: recentFiles.slice(0, MAX_RECENT), window: sanitizeWindow(record.window) };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function sanitizeWindow(value: unknown): WindowBounds | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const width = typeof raw.width === "number" && raw.width > 0 ? Math.round(raw.width) : 0;
  const height = typeof raw.height === "number" && raw.height > 0 ? Math.round(raw.height) : 0;
  if (!width || !height) return undefined;
  return {
    width,
    height,
    x: typeof raw.x === "number" ? Math.round(raw.x) : undefined,
    y: typeof raw.y === "number" ? Math.round(raw.y) : undefined,
    maximized: raw.maximized === true,
  };
}

export async function savePreferences(file: string, preferences: Preferences): Promise<void> {
  await writeFileAtomic(file, new TextEncoder().encode(JSON.stringify(preferences, null, 2)));
}
