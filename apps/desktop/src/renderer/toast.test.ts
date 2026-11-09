import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast, toastUi } from "./toast";

describe("轻量提示", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toastUi.visible = false;
    toastUi.message = "";
    toastUi.tone = "info";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("显示后 1600ms 自动隐藏", () => {
    showToast("已复制 PNG");
    expect(toastUi.visible).toBe(true);
    expect(toastUi.message).toBe("已复制 PNG");
    vi.advanceTimersByTime(1599);
    expect(toastUi.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(toastUi.visible).toBe(false);
  });

  it("连续提示覆盖文案并重置计时", () => {
    showToast("第一条");
    vi.advanceTimersByTime(1000);
    showToast("第二条", "error");
    expect(toastUi.message).toBe("第二条");
    expect(toastUi.tone).toBe("error");
    vi.advanceTimersByTime(1599);
    expect(toastUi.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(toastUi.visible).toBe(false);
  });
});
