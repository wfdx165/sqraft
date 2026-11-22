/**
 * 应用偏好（`userData/preferences.json`）：目前只有最近打开列表。
 * 纯函数 + 显式路径，测试只需临时目录，不依赖 Electron。
 */
import { readFile } from "node:fs/promises";
import { isLanguagePreference, type LanguagePreference } from "../shared/i18n";
import type { ExportSettings } from "../shared/ipc";
import type { GradientValue } from "@sqraft/core";
import { isValidPort } from "./mcp/port";
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
  language?: LanguagePreference;
  window?: WindowBounds;
  mcp?: McpPreferences;
  update?: UpdatePreferences;
  export?: ExportSettings;
  /** 用户保存的渐变预设：只存值，不存名字；跨文档可用、不随文件走（ADR-0039）。 */
  gradientPresets?: GradientValue[];
}

/** 更新状态里需要跨启动记住的部分：最小检查间隔、已下载版本、7 天提醒去过重。 */
export interface UpdatePreferences {
  /** 上次自动检查时间（毫秒）：两次自动检查之间至少隔 4 小时 */
  lastCheckAt?: number;
  /** 已下载完成、等待安装的版本 */
  readyVersion?: string;
  /** 进入"已就绪"的时间（毫秒）：满 7 天主动提醒一次 */
  readySince?: number;
  /** 已经提醒过的版本：同一版本只提醒一次 */
  remindedVersion?: string;
  /** 上次安装失败的版本：自动检查不再反复重下同一个坏包（手动检查仍放行） */
  failedVersion?: string;
  /** 自动下载开关：缺省 = true；关闭后只提示新版本，由用户手动下载 */
  autoDownload?: boolean;
}

/** MCP 端口偏好：显式端口优先；自动模式记住上次成功的端口，避免每次重启重新漂移。 */
export interface McpPreferences {
  /** 用户显式指定的端口（1024–65535）；缺省 = 自动模式 */
  port?: number;
  /** 自动模式上次成功监听的端口 */
  autoPort?: number;
}

const MAX_RECENT = 8;

/** 用户渐变预设上限：超过就提示先删，不做静默淘汰。 */
export const MAX_GRADIENT_PRESETS = 24;

/** 多倍率导出的默认值：1× + 2×，不带 SVG。 */
export const DEFAULT_EXPORT_SETTINGS: ExportSettings = { scales: [1, 2], includeSvg: false };

/** 允许的 PNG 倍率（与单文件导出的 1/2/4 一致）。 */
const EXPORT_SCALES = [1, 2, 4] as const;

/**
 * 归一化导出设置：只认 1/2/4、去重排序、至少保留一档；
 * 目录只在非空字符串时保留。主进程收到的请求与偏好里的旧数据都走这里。
 */
export function normalizeExportSettings(value: Partial<ExportSettings> | undefined): ExportSettings {
  const rawScales = Array.isArray(value?.scales) ? value.scales : DEFAULT_EXPORT_SETTINGS.scales;
  const scales = [...new Set(rawScales)]
    .filter((scale): scale is number => EXPORT_SCALES.includes(scale as (typeof EXPORT_SCALES)[number]))
    .sort((a, b) => a - b);
  const directory = typeof value?.directory === "string" && value.directory.trim() ? value.directory : undefined;
  return {
    scales: scales.length ? scales : [...DEFAULT_EXPORT_SETTINGS.scales],
    includeSvg: value?.includeSvg === true,
    ...(directory ? { directory } : {}),
  };
}

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
    const record = parsed as {
      recentFiles?: unknown;
      language?: unknown;
      window?: unknown;
      mcp?: unknown;
      update?: unknown;
      export?: unknown;
      gradientPresets?: unknown;
    };
    const recent = record.recentFiles;
    const recentFiles = Array.isArray(recent) ? recent.filter((item): item is string => typeof item === "string") : [];
    const language = isLanguagePreference(record.language) ? record.language : undefined;
    const mcp = sanitizeMcp(record.mcp);
    const update = sanitizeUpdate(record.update);
    const exportSettings = sanitizeExport(record.export);
    const gradientPresets = sanitizeGradientPresets(record.gradientPresets);
    return {
      recentFiles: recentFiles.slice(0, MAX_RECENT),
      ...(language ? { language } : {}),
      window: sanitizeWindow(record.window),
      ...(mcp ? { mcp } : {}),
      ...(update ? { update } : {}),
      ...(exportSettings ? { export: exportSettings } : {}),
      ...(gradientPresets.length > 0 ? { gradientPresets } : {}),
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function sanitizeMcp(value: unknown): McpPreferences | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const next: McpPreferences = {};
  if (isValidPort(raw.port)) next.port = raw.port;
  if (isValidPort(raw.autoPort)) next.autoPort = raw.autoPort;
  return next.port === undefined && next.autoPort === undefined ? undefined : next;
}

function sanitizeUpdate(value: unknown): UpdatePreferences | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const next: UpdatePreferences = {};
  if (typeof raw.lastCheckAt === "number" && Number.isFinite(raw.lastCheckAt)) next.lastCheckAt = raw.lastCheckAt;
  if (typeof raw.readyVersion === "string" && raw.readyVersion) next.readyVersion = raw.readyVersion;
  if (typeof raw.readySince === "number" && Number.isFinite(raw.readySince)) next.readySince = raw.readySince;
  if (typeof raw.remindedVersion === "string" && raw.remindedVersion) next.remindedVersion = raw.remindedVersion;
  if (typeof raw.failedVersion === "string" && raw.failedVersion) next.failedVersion = raw.failedVersion;
  if (typeof raw.autoDownload === "boolean") next.autoDownload = raw.autoDownload;
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * 渐变预设：只做形状上的粗筛（类型合法、from/to 是数值点、stops 是数组），
 * 深度校验留给渲染层的 `tokenGradientOf`——主进程不持有文档模型，不重复实现一套规则。
 */
export function sanitizeGradientPresets(value: unknown): GradientValue[] {
  if (!Array.isArray(value)) return [];
  const out: GradientValue[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<GradientValue>;
    if (raw.type !== "linear" && raw.type !== "radial" && raw.type !== "angular" && raw.type !== "diamond") continue;
    if (!isFinitePoint(raw.from) || !isFinitePoint(raw.to)) continue;
    if (raw.focus !== undefined && !isFinitePoint(raw.focus)) continue;
    if (!Array.isArray(raw.stops)) continue;
    out.push({
      type: raw.type,
      from: { x: raw.from!.x, y: raw.from!.y },
      to: { x: raw.to!.x, y: raw.to!.y },
      ...(raw.focus ? { focus: { x: raw.focus.x, y: raw.focus.y } } : {}),
      stops: raw.stops as GradientValue["stops"],
    });
    if (out.length >= MAX_GRADIENT_PRESETS) break;
  }
  return out;
}

function isFinitePoint(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as { x?: unknown; y?: unknown };
  return typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y);
}

/** 导出设置：形状不对就当作没有（回退默认值由调用方负责）。 */
function sanitizeExport(value: unknown): ExportSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const hasAny =
    Array.isArray(raw.scales) || typeof raw.includeSvg === "boolean" || typeof raw.directory === "string";
  return hasAny ? normalizeExportSettings(raw as Partial<ExportSettings>) : undefined;
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
