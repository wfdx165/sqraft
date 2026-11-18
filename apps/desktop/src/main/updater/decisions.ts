/**
 * 更新的两个决策点（纯函数）：
 * 1. 这次该不该发请求（最小间隔 / 进行中 / 手动）；
 * 2. 拿到 latest.json 之后该做什么（已最新 / 下载 / 跳过已知坏版本）。
 *
 * 抽出来的目的只有一个：这些分支要能被测试，而不是靠手点。
 */
import type { UpdateState } from "../../shared/ipc";
import type { UpdatePreferences } from "../preferences";
import { compareVersions, MAC_ARM64_ASSET, type LatestManifest, type UpdateAsset } from "./protocol";

/**
 * 两次自动检查之间的最小间隔：4 小时。
 *
 * 启动后、运行期轮询、系统唤醒补查都受它约束（不是"每天只查一次"的配额）；
 * 手动检查不受限制。应用可以长时间不重启，所以下限必须短于一个工作日。
 */
export const CHECK_MIN_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * 运行期轮询节奏：与闸门同源。
 *
 * 两个值分开导出只是为了让测试能锁住"相等"——如果只调轮询不改闸门，
 * 每次 tick 都会被 `shouldCheck` 静默吞掉，轮询等于没写。
 */
export const POLL_INTERVAL_MS = CHECK_MIN_INTERVAL_MS;

/** 轮询对齐余量：让 tick 落在最小间隔之后几秒，避免差几毫秒被闸门挡掉、白等一轮。 */
export const POLL_MARGIN_MS = 5_000;

export interface PollDelayInput {
  /** 偏好里"上次成功检查"的时间（从未成功过为 undefined） */
  lastCheckAt: number | undefined;
  /** 本进程内最后一次检查的发起时间（0 = 本次启动还没查过） */
  lastAttemptAt: number;
  now: number;
}

/**
 * 下一次轮询的等待时间：对齐到「上次尝试 + 最小间隔」，而不是固定从启动算 4 小时。
 *
 * 从启动时刻直接排 4 小时会差几秒（启动检查在 +5 秒才跑），那一轮会被
 * `shouldCheck` 挡掉、再等 4 小时，实际变成 8 小时一次。检查失败时
 * `lastCheckAt` 不写，所以锚点还要算上本进程的尝试时间，避免"失败即立刻重试"。
 */
export function nextPollDelay(input: PollDelayInput): number {
  const anchor = Math.max(input.lastCheckAt ?? 0, input.lastAttemptAt);
  if (!anchor) return POLL_INTERVAL_MS;
  return Math.max(POLL_MARGIN_MS, CHECK_MIN_INTERVAL_MS - (input.now - anchor) + POLL_MARGIN_MS);
}

/** 就绪多久后主动提醒一次 */
export const REMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** 弹窗前留一点余量，避免与应用启动抢焦点 */
export const REMINDER_SHOW_DELAY_MS = 3_000;

/**
 * 距离"该弹提醒"还有多久：到期时间 − 现在，再加一点余量。
 *
 * 时钟回拨时 `readySince` 可能在未来，这里把等待上限钳在 7 天，
 * 免得一个错误的时间戳把提醒推到几天之后。
 */
export function reminderDelay(input: { readySince: number; now: number }): number {
  const remaining = Math.min(REMIND_AFTER_MS, Math.max(0, input.readySince + REMIND_AFTER_MS - input.now));
  return remaining + REMINDER_SHOW_DELAY_MS;
}

/**
 * 这些阶段不发起检查：正在下载、等空闲后再下载，或已就绪等重启（手动检查也一样）。
 *
 * 轮询也要用它：就绪之后不可能再查出新版本（安装在退出时发生），
 * 继续排定时器只是空转。
 */
export function isCheckBlocked(phase: UpdateState["phase"]): boolean {
  return phase === "downloading" || phase === "waiting" || phase === "ready";
}

export interface CheckGateInput {
  prefs: UpdatePreferences;
  manual: boolean;
  phase: UpdateState["phase"];
  now: number;
}

export function shouldCheck(input: CheckGateInput): boolean {
  const { prefs, manual, phase, now } = input;
  // 已经在下/已经就绪：不打断，也不重复下载
  if (isCheckBlocked(phase)) return false;
  if (manual) return true;
  if (!prefs.lastCheckAt) return true;
  return now - prefs.lastCheckAt >= CHECK_MIN_INTERVAL_MS;
}

export interface LatestPlanInput {
  currentVersion: string;
  manifest: LatestManifest;
  /** 上次安装失败的版本：自动检查不要反复重下同一个坏包 */
  failedVersion: string | null;
  manual: boolean;
  /** 平台能否就地安装（Windows 只能提示，拿不到资产也不需要） */
  installable: boolean;
  /** 自动下载开关：关闭后即使能就地安装也只提示 */
  autoDownload: boolean;
}

export type LatestPlan =
  | { kind: "up-to-date"; version: string; notes: string | null; publishedAt: string | null }
  | { kind: "skipped-failed"; version: string }
  | { kind: "available"; version: string; notes: string | null; publishedAt: string | null }
  | {
      kind: "update";
      version: string;
      notes: string | null;
      publishedAt: string | null;
      asset: UpdateAsset;
    };

export function planForLatest(input: LatestPlanInput): LatestPlan {
  const { currentVersion, manifest, failedVersion, manual, installable, autoDownload } = input;
  const meta = { version: manifest.version, notes: manifest.notes, publishedAt: manifest.publishedAt };
  if (compareVersions(manifest.version, currentVersion) <= 0) return { kind: "up-to-date", ...meta };
  // 自动检查不重试已知坏版本；手动检查是用户明确要求，放行
  if (!manual && failedVersion && failedVersion === manifest.version) {
    return { kind: "skipped-failed", version: manifest.version };
  }
  if (!installable || !autoDownload) return { kind: "available", ...meta };
  return { kind: "update", ...meta, asset: manifest.assets[MAC_ARM64_ASSET] };
}
