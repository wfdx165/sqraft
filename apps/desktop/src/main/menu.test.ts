import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

vi.mock("electron", () => ({
  app: { name: "Sqraft", getVersion: () => "0.0.1" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  Menu: { buildFromTemplate: (template: unknown) => ({ template }), setApplicationMenu: vi.fn() },
  ipcMain: { on: vi.fn() },
}));

const { buildTemplate } = await import("./menu");

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const item of items) {
    out.push(item);
    if (Array.isArray(item.submenu)) out.push(...flatten(item.submenu));
  }
  return out;
}

describe("应用菜单", () => {
  it("macOS 上没有任何菜单项抢占 ⌘W（⌘W 留给渲染层的关闭文档）", () => {
    const items = flatten(buildTemplate("darwin"));
    expect(items.filter((item) => item.accelerator === "CommandOrControl+W")).toEqual([]);
    expect(items.some((item) => item.role === "close")).toBe(false);
  });

  it("Windows/Linux 上同样不注册 Ctrl+W", () => {
    const items = flatten(buildTemplate("win32"));
    expect(items.filter((item) => item.accelerator === "CommandOrControl+W")).toEqual([]);
  });

  it("关闭文档的 ⌘W 只做展示，不注册", () => {
    const item = flatten(buildTemplate("darwin")).find((entry) => entry.accelerator === "Command+W");
    expect(item?.label).toBe("关闭文档");
    expect(item?.registerAccelerator).toBe(false);
  });

  it("关闭窗口改到 ⇧⌘W，且只出现一次", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const items = flatten(buildTemplate(platform)).filter(
        (item) => item.accelerator === "CommandOrControl+Shift+W",
      );
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe("关闭窗口");
    }
  });

  it("五组菜单齐全", () => {
    const labels = buildTemplate("darwin").map((item) => item.label);
    expect(labels).toEqual(["Sqraft", "文件", "编辑", "视图", "窗口", "帮助"]);
  });
});
