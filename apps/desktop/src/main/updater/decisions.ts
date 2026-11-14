/**
 * 更新的两个决策点（纯函数）：
 * 1. 这次该不该发请求（节流 / 进行中 / 手动）；
 * 2. 拿到 latest.json 之后该做什么（已最新 / 下载 / 跳过已知坏版本）。
 *
 * 抽出来的目的只有一个：这些分支要能被测试，而不是靠手点。
 */
import type { UpdateState } from "../../shared/ipc";
import type { UpdatePreferences } from "../preferences";
import { compareVersions, MAC_ARM64_ASSET, type LatestManifest, type UpdateAsset } from "./protocol";

/** 自动检查节流：24 小时。手动检查不受它限制。 */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CheckGateInput {
  prefs: UpdatePreferences;
  manual: boolean;
  phase: UpdateState["phase"];
  now: number;
}

export function shouldCheck(input: CheckGateInput): boolean {
  const { prefs, manual, phase, now } = input;
  // 已经在下/已经就绪：不打断，也不重复下载
  if (phase === "downloading" || phase === "ready") return false;
  if (manual) return true;
  if (!prefs.lastCheckAt) return true;
  return now - prefs.lastCheckAt >= CHECK_INTERVAL_MS;
}

export interface LatestPlanInput {
  currentVersion: string;
  manifest: LatestManifest;
  /** 上次安装失败的版本：自动检查不要反复重下同一个坏包 */
  failedVersion: string | null;
  manual: boolean;
  /** 平台能否就地安装（Windows 只能提示，拿不到资产也不需要） */
  installable: boolean;
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
  const { currentVersion, manifest, failedVersion, manual, installable } = input;
  const meta = { version: manifest.version, notes: manifest.notes, publishedAt: manifest.publishedAt };
  if (compareVersions(manifest.version, currentVersion) <= 0) return { kind: "up-to-date", ...meta };
  // 自动检查不重试已知坏版本；手动检查是用户明确要求，放行
  if (!manual && failedVersion && failedVersion === manifest.version) {
    return { kind: "skipped-failed", version: manifest.version };
  }
  if (!installable) return { kind: "available", ...meta };
  return { kind: "update", ...meta, asset: manifest.assets[MAC_ARM64_ASSET] };
}
