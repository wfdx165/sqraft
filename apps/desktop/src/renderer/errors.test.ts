import { describe, expect, it } from "vitest";
import { AppError } from "@sqraft/core";
import { agentErrorText, localizeError } from "./errors";

describe("错误文案", () => {
  it("UI 文案跟随指定语言", () => {
    const error = new AppError("core.group.empty");
    expect(localizeError(error, "zh-CN")).toBe("请选择要分组的节点");
    expect(localizeError(error, "ja-JP")).toBe("グループ化するレイヤーを選択してください");
    expect(localizeError(error, "ko-KR")).toBe("그룹화할 레이어를 선택하세요");
  });

  it("agent 文案固定英文且不暴露内部 code", () => {
    const error = new AppError("core.slot.filled", { name: "footer" });
    const text = agentErrorText(error);
    expect(text).toContain("footer");
    expect(text).toContain("filled");
    expect(text).not.toContain("core.");
  });

  it("未知 AppError code 给出可读兜底", () => {
    expect(agentErrorText(new AppError("core.unknown"))).toBe("Operation failed (core.unknown).");
    expect(localizeError(new AppError("core.unknown"), "en-US")).toBe(
      "Something went wrong. See the log for details.",
    );
  });

  it("普通错误保留原始 message", () => {
    expect(agentErrorText(new Error("boom"))).toBe("boom");
    expect(localizeError(new Error("boom"), "ja-JP")).toBe("boom");
  });
});
