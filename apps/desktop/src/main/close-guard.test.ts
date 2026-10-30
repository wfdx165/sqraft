import { describe, expect, it, vi } from "vitest";

// close-guard 的顶层会 import electron；这里只测纯状态机，把 electron 换成最小替身
vi.mock("electron", () => ({
  app: { on: vi.fn(), quit: vi.fn() },
  BrowserWindow: class {},
  ipcMain: { on: vi.fn() },
}));

const { CloseGuard } = await import("./close-guard");

function makeGuard(options: { dirty?: boolean; hasWindow?: boolean } = {}) {
  const calls: string[] = [];
  const guard = new CloseGuard({
    hasWindow: () => options.hasWindow ?? true,
    requestClose: (request) => calls.push(`ask:${request.quit}`),
    closeWindow: () => calls.push("close"),
    quitApp: () => calls.push("quit"),
  });
  guard.attach();
  guard.setDirty(options.dirty ?? false);
  return { guard, calls };
}

describe("关闭守卫", () => {
  it("脏稿关窗：拦下并只发一次询问", () => {
    const { guard, calls } = makeGuard({ dirty: true });
    expect(guard.blockClose()).toBe(true);
    expect(guard.blockClose()).toBe(true);
    expect(calls).toEqual(["ask:false"]);
  });

  it("放行后不再拦截，并真的关窗口", () => {
    const { guard, calls } = makeGuard({ dirty: true });
    guard.blockClose();
    guard.finishClose(false);
    expect(calls).toEqual(["ask:false", "close"]);
    expect(guard.blockClose()).toBe(false);
  });

  it("重开窗口后守卫重新生效（上一轮的放行不能留下来）", () => {
    const { guard, calls } = makeGuard({ dirty: true });
    guard.blockClose();
    guard.finishClose(false);

    // 新窗口挂载
    guard.attach();
    guard.setDirty(true);
    expect(guard.blockClose()).toBe(true);
    expect(calls).toEqual(["ask:false", "close", "ask:false"]);
  });

  it("取消后仍然拦截，下次关闭会再问一次", () => {
    const { guard, calls } = makeGuard({ dirty: true });
    guard.blockClose();
    guard.cancelClose();
    expect(guard.blockClose()).toBe(true);
    expect(calls).toEqual(["ask:false", "ask:false"]);
  });

  it("退出：脏稿且没有窗口时不拦（避免弹无人应答的框）", () => {
    const { guard, calls } = makeGuard({ dirty: true, hasWindow: false });
    expect(guard.blockQuit()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("退出：脏稿有窗口时拦下并标记 quit", () => {
    const { guard, calls } = makeGuard({ dirty: true });
    expect(guard.blockQuit()).toBe(true);
    expect(calls).toEqual(["ask:true"]);
    guard.finishClose(true);
    expect(calls).toEqual(["ask:true", "quit"]);
  });

  it("退出：干净稿直接放行，随后的关窗也不再拦", () => {
    const { guard, calls } = makeGuard({ dirty: false });
    expect(guard.blockQuit()).toBe(false);
    expect(guard.blockClose()).toBe(false);
    expect(calls).toEqual([]);
  });
});
