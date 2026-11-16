import { beforeEach, describe, expect, it } from "vitest";
import { closeSettings, openSettings, settingsUi, toggleSettings } from "./settings";

describe("设置窗口路由", () => {
  beforeEach(() => closeSettings());

  it("无参打开保留上次停留的分类", () => {
    openSettings("mcp");
    closeSettings();
    openSettings();
    expect(settingsUi.section).toBe("mcp");
    expect(settingsUi.open).toBe(true);
  });

  it("带参数的深层链接覆盖当前分类", () => {
    openSettings("general");
    openSettings("shortcuts");
    expect(settingsUi.section).toBe("shortcuts");
  });

  it("同一个分类再触发一次入口 = 关闭，不同分类则切换", () => {
    toggleSettings("shortcuts");
    expect(settingsUi.open).toBe(true);
    toggleSettings("shortcuts");
    expect(settingsUi.open).toBe(false);
    toggleSettings("advanced");
    toggleSettings("mcp");
    expect(settingsUi.section).toBe("mcp");
    expect(settingsUi.open).toBe(true);
  });
});
