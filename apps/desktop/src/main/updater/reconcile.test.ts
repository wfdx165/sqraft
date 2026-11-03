import { describe, expect, it } from "vitest";
import { reconcileOnStart, type ReconcileInput } from "./reconcile";

const now = 1_700_000_000_000;

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    currentVersion: "0.1.0",
    prefs: {},
    failedVersion: null,
    zipPresent: false,
    now,
    ...overrides,
  };
}

describe("启动状态恢复", () => {
  it("没有任何残留时是 idle", () => {
    const result = reconcileOnStart(input());
    expect(result.state.phase).toBe("idle");
    expect(result.patch).toEqual({});
    expect(result.removeZip).toBe(false);
    expect(result.prompt).toBeNull();
  });

  it("安装失败回执优先于已下载包：不能让坏包被重新认领", () => {
    const result = reconcileOnStart(
      input({
        failedVersion: "0.2.0",
        zipPresent: true,
        prefs: { readyVersion: "0.2.0", readySince: now - 1000, remindedVersion: "0.2.0" },
      }),
    );
    expect(result.state.phase).toBe("error");
    expect(result.state.message).toContain("0.2.0");
    expect(result.removeZip).toBe(true);
    expect(result.clearFailure).toBe(true);
    expect(result.prompt).toContain("已回滚");
    // 清掉 ready 相关字段，并记住失败版本，避免自动检查反复重下
    expect(result.patch).toEqual({
      readyVersion: undefined,
      readySince: undefined,
      remindedVersion: undefined,
      failedVersion: "0.2.0",
    });
  });

  it("已就绪版本不高于当前版本：清残留并删包", () => {
    const result = reconcileOnStart(
      input({ prefs: { readyVersion: "0.1.0", readySince: now }, zipPresent: true }),
    );
    expect(result.state.phase).toBe("idle");
    expect(result.removeZip).toBe(true);
    expect(result.patch.readyVersion).toBeUndefined();
  });

  it("偏好说已就绪但包不在：不假装能装", () => {
    const result = reconcileOnStart(
      input({ prefs: { readyVersion: "0.2.0", readySince: now }, zipPresent: false }),
    );
    expect(result.state.phase).toBe("idle");
    expect(result.state.latestVersion).toBeNull();
    expect(result.patch.readyVersion).toBeUndefined();
  });

  it("正常接管已下载包，并保留原来的 readySince", () => {
    const since = now - 5_000;
    const result = reconcileOnStart(
      input({ prefs: { readyVersion: "0.2.0", readySince: since, remindedVersion: "0.2.0" }, zipPresent: true }),
    );
    expect(result.state.phase).toBe("ready");
    expect(result.state.latestVersion).toBe("0.2.0");
    expect(result.state.readyAt).toBe(since);
    expect(result.state.progress).toBe(1);
    expect(result.patch).toEqual({});
  });

  it("缺少 readySince 时补上当前时间", () => {
    const result = reconcileOnStart(input({ prefs: { readyVersion: "0.2.0" }, zipPresent: true }));
    expect(result.state.readyAt).toBe(now);
    expect(result.patch.readySince).toBe(now);
  });
});
