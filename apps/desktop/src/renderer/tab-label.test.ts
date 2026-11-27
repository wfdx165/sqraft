import { afterEach, describe, expect, it } from "vitest";
import { createEmptyDoc } from "@sqraft/core";
import { locale } from "./i18n";
import { createDocTab, resetSessions } from "./sessions";
import { tabLabel } from "./tab-label";

afterEach(() => {
  locale.value = "zh-CN";
  resetSessions();
});

describe("标签显示名", () => {
  it("有文件名就用文件名", () => {
    const tab = createDocTab(createEmptyDoc(), { name: "登录页" });
    expect(tabLabel(tab)).toBe("登录页");
  });

  it("未命名用创建时的序号，四语同一套模板", () => {
    const tab = createDocTab(createEmptyDoc());
    locale.value = "zh-CN";
    expect(tabLabel(tab)).toBe("未命名 1");
    locale.value = "en-US";
    expect(tabLabel(tab)).toBe("Untitled 1");
    locale.value = "ja-JP";
    expect(tabLabel(tab)).toBe("無題 1");
    locale.value = "ko-KR";
    expect(tabLabel(tab)).toBe("제목 없음 1");
  });

  it("没有序号（老数据）回退到不编号的名字", () => {
    const tab = createDocTab(createEmptyDoc());
    tab.file.untitledIndex = null;
    expect(tabLabel(tab)).toBe("未命名");
  });
});
