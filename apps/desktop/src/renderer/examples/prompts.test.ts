import { describe, expect, it } from "vitest";
import { EXAMPLE_PROMPTS } from "./prompts";

describe("示例 prompt", () => {
  it("三条，正文包含关键工具名与格式串", () => {
    expect(EXAMPLE_PROMPTS.map((item) => item.id)).toEqual(["cards", "tokens", "diagnostics"]);
    const text = EXAMPLE_PROMPTS.map((item) => item.text).join("\n");
    expect(text).toContain("create_nodes");
    expect(text).toContain('screenshot({format:"text"})');
    expect(text).toContain("define_token");
    expect(text).toContain("fillToken");
    expect(text).toContain("strict mode");
  });

  it("正文是英文常量，不走字典", () => {
    for (const prompt of EXAMPLE_PROMPTS) {
      expect(prompt.text.length).toBeGreaterThan(80);
      expect(prompt.titleKey.startsWith("onboarding.")).toBe(true);
      expect(prompt.descKey.startsWith("onboarding.")).toBe(true);
    }
  });
});
