// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { locale } from "./i18n";
import { updateIncompatible, updateStatusText, updateUi } from "./update";

beforeEach(() => {
  locale.value = "zh-CN";
  Object.assign(updateUi, {
    phase: "incompatible",
    currentVersion: "0.1.2",
    latestVersion: "0.2.0",
    notes: null,
    publishedAt: null,
    minOS: "12.0",
    progress: 0,
    message: null,
    readyAt: null,
    supported: true,
    autoDownload: true,
  });
});

describe("更新状态文案", () => {
  it("incompatible 同时给出新版本与系统要求", () => {
    expect(updateIncompatible.value).toBe(true);
    expect(updateStatusText()).toContain("0.2.0");
    expect(updateStatusText()).toContain("12.0");
  });

  it("其他阶段不受 minOS 影响", () => {
    updateUi.phase = "up-to-date";
    expect(updateStatusText()).toContain("已是最新");
  });
});
