import { describe, expect, it } from "vitest";
import { releasePageUrl } from "./links";

describe("更新发布页链接", () => {
  it("incompatible 打开 Releases 列表，而不是 latest", () => {
    expect(releasePageUrl("a/b", "incompatible")).toBe("https://github.com/a/b/releases");
  });

  it("其他阶段仍打开 latest", () => {
    for (const phase of ["available", "ready", "idle"] as const) {
      expect(releasePageUrl("a/b", phase)).toBe("https://github.com/a/b/releases/latest");
    }
  });
});
