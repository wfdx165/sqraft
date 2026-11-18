import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadWatchdog } from "./download";

/** 缩小的三档超时：行为与默认一致，跑得快 */
const FAST = { connect: 1_000, idle: 2_000, hardCap: 10_000 } as const;

describe("下载看门狗", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("默认连接超时是 60 秒", () => {
    const watchdog = new DownloadWatchdog();
    vi.advanceTimersByTime(59_999);
    expect(watchdog.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.failure).toBeInstanceOf(Error);
    // 超时文案会挂到 signal 上，供调用方替换底层的 AbortError
    expect(watchdog.signal.reason).toBe(watchdog.failure);
  });

  it("响应头到达后不再按连接超时中止（慢网只要还在进数据就继续）", () => {
    const watchdog = new DownloadWatchdog(FAST);
    watchdog.connected();
    // 3.2 秒已经超过 1 秒的连接超时；每 0.8 秒有数据进来，空闲计时一直被重置
    for (let index = 0; index < 4; index += 1) {
      vi.advanceTimersByTime(800);
      watchdog.touch();
    }
    expect(watchdog.signal.aborted).toBe(false);
  });

  it("超过空闲上限就中止", () => {
    const watchdog = new DownloadWatchdog(FAST);
    watchdog.connected();
    vi.advanceTimersByTime(1_999);
    expect(watchdog.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.failure).not.toBeNull();
  });

  it("touch 会重置空闲计时", () => {
    const watchdog = new DownloadWatchdog(FAST);
    watchdog.connected();
    vi.advanceTimersByTime(1_500);
    watchdog.touch();
    vi.advanceTimersByTime(1_500);
    expect(watchdog.signal.aborted).toBe(false);
    vi.advanceTimersByTime(600);
    expect(watchdog.signal.aborted).toBe(true);
  });

  it("数据一直进来也会被硬上限兜住", () => {
    const watchdog = new DownloadWatchdog(FAST);
    watchdog.connected();
    for (let index = 0; index < 9; index += 1) {
      vi.advanceTimersByTime(1_000);
      watchdog.touch();
    }
    expect(watchdog.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(watchdog.signal.aborted).toBe(true);
  });

  it("dispose 后不再中止（响应体已收完）", () => {
    const watchdog = new DownloadWatchdog(FAST);
    watchdog.dispose();
    vi.advanceTimersByTime(60_000);
    expect(watchdog.signal.aborted).toBe(false);
    expect(watchdog.failure).toBeNull();
  });
});
