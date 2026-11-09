import { describe, expect, it, vi } from "vitest";

/**
 * 快捷键全局分发的重复触发回归（`.scratch/logging/issues/02-save-race-fixes.md`）：
 * 按住 ⌘S 连发时，只有第一次按下分发执行——`action` 日志也不出现 repeat 的第二条。
 *
 * 模块顶层读 `localStorage` 与 `window`，所以先打桩再动态导入。
 */
type KeyHandler = (e: unknown) => void;

const storage = new Map<string, string>();
let handler: KeyHandler | null = null;
const logged: { level: string; event: string }[] = [];

vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});

vi.stubGlobal("window", {
  addEventListener: (_type: string, fn: KeyHandler) => {
    handler = fn;
  },
  removeEventListener: () => {
    handler = null;
  },
  sqraft: {
    app: {
      log: (level: string, event: string) => logged.push({ level, event }),
    },
  },
});

const { installShortcuts, registerShortcuts } = await import("./shortcuts");

/** 造一个带 ⌘ 的字母键事件（只带分发路径会读到的字段）。 */
function metaKey(letter: string, repeat = false): KeyboardEvent {
  return {
    isComposing: false,
    repeat,
    key: letter.toLowerCase(),
    code: `Key${letter.toUpperCase()}`,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe("按键的重复分发", () => {
  it("首次按下执行一次，后续 repeat 不再分发，日志也只有一条 action", () => {
    logged.length = 0;
    const run = vi.fn();
    const off = registerShortcuts({ "file.save": run });
    const uninstall = installShortcuts();

    handler!(metaKey("S", false));
    handler!(metaKey("S", true));
    handler!(metaKey("S", true));

    expect(run).toHaveBeenCalledTimes(1);
    expect(logged.filter((entry) => entry.event === "action")).toHaveLength(1);

    off();
    uninstall();
  });

  it("非 repeat 的常规键位照常分发（repeat 守卫不误伤）", () => {
    logged.length = 0;
    const run = vi.fn();
    const off = registerShortcuts({ "file.new": run });
    const uninstall = installShortcuts();

    handler!(metaKey("N", false));

    expect(run).toHaveBeenCalledTimes(1);
    expect(logged.filter((entry) => entry.event === "action")).toHaveLength(1);

    off();
    uninstall();
  });
});
