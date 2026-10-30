import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

/** 主进程菜单测试用的假窗口（菜单点击时才现取，见 BrowserWindow.getAllWindows） */
let windows: Array<{ webContents: Record<string, unknown> }> = [];

vi.mock("electron", () => ({
  app: { name: "Sqraft", getVersion: () => "0.0.1" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => windows },
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

/** 点一下菜单项（Electron 的 click 有参数，这里只关心无副作用地触发） */
function clickItem(item: MenuItemConstructorOptions | undefined): void {
  const click = item?.click as (() => void) | undefined;
  click?.();
}

function devtoolsItem(platform: NodeJS.Platform): MenuItemConstructorOptions | undefined {
  const group = buildTemplate(platform).find((item) => item.label === "开发者");
  if (!Array.isArray(group?.submenu)) return undefined;
  return group.submenu.find((item) => item.label === "开发者工具");
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

  it("菜单分组齐全（含开发者）", () => {
    const labels = buildTemplate("darwin").map((item) => item.label);
    expect(labels).toEqual(["Sqraft", "文件", "编辑", "开发者", "视图", "窗口", "帮助"]);
  });

  it("开发者菜单只有自带 DevTools，快捷键按平台区分", () => {
    const macGroup = buildTemplate("darwin").find((item) => item.label === "开发者");
    expect(macGroup?.submenu).toHaveLength(1);
    expect(devtoolsItem("darwin")?.accelerator).toBe("Command+Alt+I");
    // Windows/Linux 的 Ctrl+Shift+I 是渲染层的「插入图片」，所以用 F12
    for (const platform of ["win32", "linux"] as const) {
      expect(devtoolsItem(platform)?.accelerator).toBe("F12");
    }
  });

  it("开发者工具：右侧停靠，再点一次关闭", () => {
    const calls: string[] = [];
    const contents = {
      isDevToolsOpened: () => calls.at(-1) === "open",
      openDevTools: (options?: { mode?: string }) => calls.push(options?.mode === "right" ? "open" : "bad-mode"),
      closeDevTools: () => calls.push("closed"),
    };
    windows = [{ webContents: contents }];
    try {
      clickItem(devtoolsItem("darwin"));
      expect(calls).toEqual(["open"]);
      clickItem(devtoolsItem("darwin"));
      expect(calls).toEqual(["open", "closed"]);
    } finally {
      windows = [];
    }
  });

  it("开发者工具：没有窗口时静默返回", () => {
    expect(() => clickItem(devtoolsItem("darwin"))).not.toThrow();
  });
});
