import { describe, expect, it } from "vitest";
import {
  CHECK_MIN_INTERVAL_MS,
  isCheckBlocked,
  nextPollDelay,
  POLL_INTERVAL_MS,
  POLL_MARGIN_MS,
  planForLatest,
  REMIND_AFTER_MS,
  REMINDER_SHOW_DELAY_MS,
  reminderDelay,
  shouldCheck,
} from "./decisions";
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

  it("自动检查的最小间隔是 4 小时", () => {
    expect(CHECK_MIN_INTERVAL_MS).toBe(4 * 60 * 60 * 1000);
    expect(shouldCheck({ prefs: {}, manual: false, phase: "idle", now })).toBe(true);
    expect(
      shouldCheck({ prefs: { lastCheckAt: now - 60 * 60 * 1000 }, manual: false, phase: "idle", now }),
    ).toBe(false);
    expect(
      shouldCheck({ prefs: { lastCheckAt: now - CHECK_MIN_INTERVAL_MS - 1 }, manual: false, phase: "idle", now }),
    ).toBe(true);
  });

  it("轮询节奏与闸门同源（只调一个会让轮询被静默吞掉）", () => {
    expect(POLL_INTERVAL_MS).toBe(CHECK_MIN_INTERVAL_MS);
  });

  it("进行中或已就绪时自动检查也不打断", () => {
    for (const phase of ["downloading", "ready"] as const) {
      expect(isCheckBlocked(phase)).toBe(true);
      expect(shouldCheck({ prefs: {}, manual: false, phase, now })).toBe(false);
    }
  });
});

describe("被阻断的阶段", () => {
  it("下载中 / 等空闲 / 已就绪阻断，其余阶段放行", () => {
    const blocked = ["idle", "checking", "up-to-date", "available", "error", "dev", "unsupported"].filter(
      (phase) => isCheckBlocked(phase as Parameters<typeof isCheckBlocked>[0]),
    );
    expect(blocked).toEqual([]);
    expect(isCheckBlocked("downloading")).toBe(true);
    expect(isCheckBlocked("waiting")).toBe(true);
    expect(isCheckBlocked("ready")).toBe(true);
  });
});

describe("7 天提醒的等待时间", () => {
  it("刚就绪时等满 7 天再加余量", () => {
    expect(reminderDelay({ readySince: now, now })).toBe(REMIND_AFTER_MS + REMINDER_SHOW_DELAY_MS);
  });

  it("已就绪 6 天时只等剩下的一天", () => {
    const sixDays = 6 * 24 * 60 * 60 * 1000;
    expect(reminderDelay({ readySince: now - sixDays, now })).toBe(
      REMIND_AFTER_MS - sixDays + REMINDER_SHOW_DELAY_MS,
    );
  });

  it("早该提醒时只留弹窗余量", () => {
    expect(reminderDelay({ readySince: now - 30 * 24 * 60 * 60 * 1000, now })).toBe(REMINDER_SHOW_DELAY_MS);
  });

  it("时钟回拨导致 readySince 在未来时，也不会把提醒推到 7 天以外", () => {
    expect(reminderDelay({ readySince: now + 24 * 60 * 60 * 1000, now })).toBe(
      REMIND_AFTER_MS + REMINDER_SHOW_DELAY_MS,
    );
  });
});

describe("运行期轮询的等待时间", () => {
  it("从未查过时按完整间隔排", () => {
    expect(nextPollDelay({ lastCheckAt: undefined, lastAttemptAt: 0, now })).toBe(POLL_INTERVAL_MS);
  });

  it("成功检查刚跑完时，等满一个间隔再加余量（不会差几秒被闸门挡成 8 小时一轮）", () => {
    expect(nextPollDelay({ lastCheckAt: now, lastAttemptAt: now, now })).toBe(POLL_INTERVAL_MS + POLL_MARGIN_MS);
  });

  it("检查失败不写 lastCheckAt，也要按发起时间对齐，不能立刻重试", () => {
    const attempted = now - 60 * 60 * 1000;
    expect(nextPollDelay({ lastCheckAt: undefined, lastAttemptAt: attempted, now })).toBe(
      POLL_INTERVAL_MS - 60 * 60 * 1000 + POLL_MARGIN_MS,
    );
  });

  it("锚点已经过期时也不小于余量", () => {
    const old = now - 10 * 60 * 60 * 1000;
    expect(nextPollDelay({ lastCheckAt: old, lastAttemptAt: 0, now })).toBe(POLL_MARGIN_MS);
  });
});

describe("拿到 latest.json 之后", () => {
  const base = {
    currentVersion: "0.1.0",
    failedVersion: null,
    manual: false,
    installable: true,
    autoDownload: true,
  } as const;

  it("不高于当前版本 → 已是最新，不下载", () => {
    expect(planForLatest({ ...base, currentVersion: "0.2.0", manifest: manifest("0.2.0"), manual: true }).kind).toBe(
      "up-to-date",
    );
    expect(planForLatest({ ...base, currentVersion: "0.3.0", manifest: manifest("0.2.9"), manual: true }).kind).toBe(
      "up-to-date",
    );
  });

  it("更高版本 → 带 mac-arm64 资产去下载", () => {
    const plan = planForLatest({ ...base, manifest: manifest("0.2.0") });
    expect(plan.kind).toBe("update");
    if (plan.kind !== "update") throw new Error("unreachable");
    expect(plan.asset.sha256).toBe(sha);
    expect(plan.notes).toBe("说明");
  });

  it("不能就地安装的平台（Windows）只提示新版本，不要求资产", () => {
    const plan = planForLatest({ ...base, manifest: manifest("0.2.0"), installable: false });
    expect(plan.kind).toBe("available");
    if (plan.kind !== "available") throw new Error("unreachable");
    expect(plan.version).toBe("0.2.0");
    expect(plan.notes).toBe("说明");
  });

  it("关闭自动下载后只提示新版本（与 Windows 同一条路径）", () => {
    const plan = planForLatest({ ...base, manifest: manifest("0.2.0"), autoDownload: false });
    expect(plan.kind).toBe("available");
  });

  it("自动检查跳过上次装坏的同一个版本", () => {
    const plan = planForLatest({ ...base, manifest: manifest("0.2.0"), failedVersion: "0.2.0" });
    expect(plan.kind).toBe("skipped-failed");
  });

  it("手动检查仍允许重试失败过的版本（偶发失败可以自愈）", () => {
    const plan = planForLatest({ ...base, manifest: manifest("0.2.0"), failedVersion: "0.2.0", manual: true });
    expect(plan.kind).toBe("update");
  });

  it("失败版本之后出现更高版本时自动检查恢复", () => {
    const plan = planForLatest({ ...base, manifest: manifest("0.2.1"), failedVersion: "0.2.0" });
    expect(plan.kind).toBe("update");
  });
});
