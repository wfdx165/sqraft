import { describe, expect, it } from "vitest";
import { CHECK_INTERVAL_MS, planForLatest, shouldCheck } from "./decisions";
import { parseLatest } from "./protocol";

const now = 1_700_000_000_000;
const sha = "b".repeat(64);

function manifest(version: string) {
  return parseLatest({
    version,
    notes: "说明",
    publishedAt: "2026-11-03T00:00:00Z",
    assets: {
      "mac-arm64": {
        url: "https://github.com/wfdx165/sqraft/releases/download/v2/Sqraft.zip",
        sha256: sha,
      },
    },
  });
}

describe("检查更新的闸门", () => {
  it("手动检查永远放行（除了正在下载/已就绪）", () => {
    expect(shouldCheck({ prefs: { lastCheckAt: now - 1000 }, manual: true, phase: "idle", now })).toBe(true);
    expect(shouldCheck({ prefs: {}, manual: true, phase: "downloading", now })).toBe(false);
    expect(shouldCheck({ prefs: {}, manual: true, phase: "ready", now })).toBe(false);
  });

  it("自动检查按 24 小时节流", () => {
    expect(shouldCheck({ prefs: {}, manual: false, phase: "idle", now })).toBe(true);
    expect(
      shouldCheck({ prefs: { lastCheckAt: now - 60 * 60 * 1000 }, manual: false, phase: "idle", now }),
    ).toBe(false);
    expect(
      shouldCheck({ prefs: { lastCheckAt: now - CHECK_INTERVAL_MS - 1 }, manual: false, phase: "idle", now }),
    ).toBe(true);
  });

  it("进行中或已就绪时自动检查也不打断", () => {
    for (const phase of ["downloading", "ready"] as const) {
      expect(shouldCheck({ prefs: {}, manual: false, phase, now })).toBe(false);
    }
  });
});

describe("拿到 latest.json 之后", () => {
  it("不高于当前版本 → 已是最新，不下载", () => {
    expect(planForLatest({ currentVersion: "0.2.0", manifest: manifest("0.2.0"), failedVersion: null, manual: true }).kind).toBe(
      "up-to-date",
    );
    expect(planForLatest({ currentVersion: "0.3.0", manifest: manifest("0.2.9"), failedVersion: null, manual: true }).kind).toBe(
      "up-to-date",
    );
  });

  it("更高版本 → 带 mac-arm64 资产去下载", () => {
    const plan = planForLatest({ currentVersion: "0.1.0", manifest: manifest("0.2.0"), failedVersion: null, manual: false });
    expect(plan.kind).toBe("update");
    if (plan.kind !== "update") throw new Error("unreachable");
    expect(plan.asset.sha256).toBe(sha);
    expect(plan.notes).toBe("说明");
  });

  it("自动检查跳过上次装坏的同一个版本", () => {
    const plan = planForLatest({
      currentVersion: "0.1.0",
      manifest: manifest("0.2.0"),
      failedVersion: "0.2.0",
      manual: false,
    });
    expect(plan.kind).toBe("skipped-failed");
  });

  it("手动检查仍允许重试失败过的版本（偶发失败可以自愈）", () => {
    const plan = planForLatest({
      currentVersion: "0.1.0",
      manifest: manifest("0.2.0"),
      failedVersion: "0.2.0",
      manual: true,
    });
    expect(plan.kind).toBe("update");
  });

  it("失败版本之后出现更高版本时自动检查恢复", () => {
    const plan = planForLatest({
      currentVersion: "0.1.0",
      manifest: manifest("0.2.1"),
      failedVersion: "0.2.0",
      manual: false,
    });
    expect(plan.kind).toBe("update");
  });
});
