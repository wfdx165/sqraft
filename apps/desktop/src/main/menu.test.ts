import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

/** 主进程菜单测试用的假窗口（菜单点击时才现取，见 BrowserWindow.getAllWindows） */
let windows: Array<{ webContents: Record<string, unknown> }> = [];

vi.mock("electron", () => ({
  app: { name: "Sqraft", getVersion: () => "0.0.1", isPackaged: false },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => windows },
  Menu: { buildFromTemplate: (template: unknown) => ({ template }), setApplicationMenu: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: { openPath: vi.fn() },
}));

vi.mock("./image-cache", () => ({ clearImageCache: vi.fn(async () => 0) }));

const { buildTemplate, runMainCommand, registerMenuChannels, setMenuState } = await import("./menu");
const { setMainLanguage } = await import("./i18n");

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

/** 帮助菜单的子项（Electron 的 submenu 类型是数组或 Menu，这里只取数组） */
function helpSubmenu(
  platform: NodeJS.Platform,
  options: { showDevTools?: boolean } = {},
): MenuItemConstructorOptions[] {
  const help = buildTemplate(platform, options).find((item) => item.label === "帮助");
  return Array.isArray(help?.submenu) ? help.submenu : [];
}

function devtoolsItem(
  platform: NodeJS.Platform,
  options: { showDevTools?: boolean } = { showDevTools: true },
): MenuItemConstructorOptions | undefined {
  return helpSubmenu(platform, options).find((item) => item.label === "开发者工具");
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

  it("菜单分组齐全（没有开发者分组，开发者工具在帮助里）", () => {
    const labels = buildTemplate("darwin", { showDevTools: true }).map((item) => item.label);
    expect(labels).toEqual(["Sqraft", "文件", "编辑", "视图", "窗口", "帮助"]);
  });

  it("切换到英文后菜单标签跟随", () => {
    setMainLanguage("en-US");
    try {
      const labels = buildTemplate("darwin").map((item) => item.label);
      expect(labels).toEqual(["Sqraft", "File", "Edit", "View", "Window", "Help"]);
    } finally {
      setMainLanguage("zh-CN");
    }
  });

  it("「配置 MCP…」在 macOS 应用菜单里紧挨「设置…」，帮助里不再有", () => {
    const appMenu = buildTemplate("darwin")[0];
    const labels = Array.isArray(appMenu.submenu) ? appMenu.submenu.map((item) => item.label) : [];
    expect(labels.slice(0, 3)).toEqual(["关于 Sqraft", "设置…", "配置 MCP…"]);
    expect(helpSubmenu("darwin").map((item) => item.label)).not.toContain("配置 MCP…");
  });

  it("Windows/Linux 把「配置 MCP…」放进文件菜单", () => {
    for (const platform of ["win32", "linux"] as const) {
      const file = buildTemplate(platform).find((item) => item.label === "文件");
      const labels = Array.isArray(file?.submenu) ? file.submenu.map((item) => item.label) : [];
      expect(labels).toContain("配置 MCP…");
      expect(helpSubmenu(platform).map((item) => item.label)).not.toContain("配置 MCP…");
    }
  });

  it("Windows/Linux 的文件菜单也能打开设置", () => {
    for (const platform of ["win32", "linux"] as const) {
      const file = buildTemplate(platform).find((item) => item.label === "文件");
      const item = Array.isArray(file?.submenu)
        ? file.submenu.find((entry) => entry.label === "设置…")
        : undefined;
      expect(item).toBeTruthy();
      const sent: string[] = [];
      windows = [{ webContents: { send: (_channel: string, action: string) => sent.push(action) } }];
      try {
        clickItem(item);
      } finally {
        windows = [];
      }
      expect(sent).toContain("app.settings");
    }
  });

  it("开发者工具在帮助菜单，快捷键按平台区分", () => {
    expect(helpSubmenu("darwin", { showDevTools: true }).map((item) => item.label)).toEqual([
      "检查更新…",
      "打开日志目录",
      undefined,
      "开发者工具",
      undefined,
      "关于 Sqraft",
    ]);
    expect(devtoolsItem("darwin")?.accelerator).toBe("Command+Alt+I");
    // Windows/Linux 的 Ctrl+Shift+I 是渲染层的「插入图片」，所以用 F12
    for (const platform of ["win32", "linux"] as const) {
      expect(devtoolsItem(platform)?.accelerator).toBe("F12");
    }
  });

  it("打包版不显示开发者工具，也不留悬空分隔线", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(devtoolsItem(platform, { showDevTools: false })).toBeUndefined();
      expect(helpSubmenu(platform, { showDevTools: false }).map((item) => item.label)).toEqual([
        "检查更新…",
        "打开日志目录",
        undefined,
        "关于 Sqraft",
      ]);
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

describe("主进程命令派发", () => {
  it("只处理 owner === main 的命令", async () => {
    expect(await runMainCommand("file.save")).toBe(false);
    expect(await runMainCommand("edit.undo")).toBe(false);
  });

  it("没有窗口时转发类命令返回 false", async () => {
    windows = [];
    expect(await runMainCommand("app.settings")).toBe(false);
  });

  it("有窗口时把 UI 类命令发回渲染层", async () => {
    const sent: string[] = [];
    windows = [{ webContents: { send: (_channel: string, action: string) => sent.push(action) } }];
    try {
      expect(await runMainCommand("app.settings")).toBe(true);
    } finally {
      windows = [];
    }
    expect(sent).toEqual(["app.settings"]);
  });

  it("日志目录命令在主进程直接执行并返回 true", async () => {
    expect(await runMainCommand("app.openLogsDir")).toBe(true);
  });

  it("清缓存命令走主进程对话框并返回 true", async () => {
    const { dialog } = await import("electron");
    expect(await runMainCommand("app.clearImageCache")).toBe(true);
    expect(vi.mocked(dialog.showMessageBox)).toHaveBeenCalled();
  });

  it("IPC handler 拒绝未知 id 与非 main 命令", async () => {
    const { ipcMain } = await import("electron");
    const { CHANNELS } = await import("../shared/ipc");
    registerMenuChannels();
    const entry = vi
      .mocked(ipcMain.handle)
      .mock.calls.find((call) => call[0] === CHANNELS.appRunCommand);
    const handler = entry?.[1] as ((event: unknown, id: unknown) => unknown) | undefined;
    expect(handler).toBeTypeOf("function");
    expect(handler!({}, "bogus")).toBe(false);
    expect(handler!({}, "file.save")).toBe(false);
  });
});

describe("菜单按会话状态置灰", () => {
  // 模块级状态会留在后面的用例里：测完恢复成"有文档、不在演示"
  afterEach(() => setMenuState({ docOpen: true, presenting: false }));

  /** 按中文标签取菜单项（测试默认语言是 zh-CN）。 */
  function itemAt(label: string, platform: NodeJS.Platform = "darwin"): MenuItemConstructorOptions | undefined {
    return flatten(buildTemplate(platform)).find((item) => item.label === label);
  }

  const docOnly = [
    "插入图片…",
    "保存",
    "另存为…",
    "关闭文档",
    "撤销",
    "重做",
    "放大",
    "缩小",
    "演示",
  ];

  it("没有文档时，需要文档的项全部置灰", () => {
    setMenuState({ docOpen: false, presenting: false });
    for (const label of docOnly) {
      expect(itemAt(label)?.enabled, label).toBe(false);
    }
    // 导出整组：父项与四个子项都灰
    const exportAs = itemAt("导出为");
    expect(exportAs?.enabled).toBe(false);
    const children = Array.isArray(exportAs?.submenu) ? exportAs!.submenu : [];
    expect(children.map((item) => item.enabled)).toEqual([false, false, false, false]);
  });

  it("没有文档时，新建/打开/复制/剪切/粘贴/全选仍可用", () => {
    setMenuState({ docOpen: false, presenting: false });
    for (const label of ["新建", "打开…", "复制", "剪切", "粘贴", "全选"]) {
      expect(itemAt(label)?.enabled, label).not.toBe(false);
    }
  });

  it("打开文档后全部恢复", () => {
    setMenuState({ docOpen: true, presenting: false });
    for (const label of [...docOnly, "导出为"]) {
      expect(itemAt(label)?.enabled, label).not.toBe(false);
    }
    const exportAs = itemAt("导出为");
    const children = Array.isArray(exportAs?.submenu) ? exportAs!.submenu : [];
    expect(children.every((item) => item.enabled !== false)).toBe(true);
  });

  it("演示中除「演示」外全灰", () => {
    setMenuState({ docOpen: true, presenting: true });
    for (const label of ["保存", "撤销", "放大", "复制", "粘贴", "导出为"]) {
      expect(itemAt(label)?.enabled, label).toBe(false);
    }
    expect(itemAt("演示")?.enabled).not.toBe(false);
  });
});
