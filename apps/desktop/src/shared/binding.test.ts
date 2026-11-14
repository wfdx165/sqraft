import { describe, expect, it } from "vitest";
import { formatBinding } from "./binding";

describe("键位的平台显示", () => {
  it("macOS 原样返回", () => {
    expect(formatBinding("⌘⇧Z", "darwin")).toBe("⌘⇧Z");
    expect(formatBinding("⌥⌘Enter", "darwin")).toBe("⌥⌘Enter");
    expect(formatBinding("H", "darwin")).toBe("H");
  });

  it("Windows 用 Ctrl / Alt / Shift 全称并以 + 连接", () => {
    expect(formatBinding("⌘S", "win32")).toBe("Ctrl+S");
    expect(formatBinding("⌘⇧Z", "win32")).toBe("Ctrl+Shift+Z");
    expect(formatBinding("⇧1", "win32")).toBe("Shift+1");
  });

  it("修饰键按 Ctrl → Alt → Shift 排列，与书写顺序无关", () => {
    expect(formatBinding("⌥⌘Enter", "win32")).toBe("Ctrl+Alt+Enter");
    expect(formatBinding("⇧⌘I", "win32")).toBe("Ctrl+Shift+I");
  });

  it("单键不加前缀；⌘− 转成键帽上的 -", () => {
    expect(formatBinding("H", "win32")).toBe("H");
    expect(formatBinding("Delete", "win32")).toBe("Delete");
    expect(formatBinding("⌘−", "win32")).toBe("Ctrl+-");
    expect(formatBinding("⌘+", "win32")).toBe("Ctrl++");
  });
});
