import { describe, expect, it } from "vitest";
import { tokenGradientOf, type GradientValue } from "@sqraft/core";
import {
  BUILTIN_GRADIENT_PRESETS,
  MAX_GRADIENT_PRESETS,
  appendPreset,
  normalizePresets,
  previewCss,
  removePreset,
} from "../src/renderer/gradient-presets";

const linear: GradientValue = {
  type: "linear",
  from: { x: 0, y: 0.5 },
  to: { x: 1, y: 0.5 },
  stops: [
    { offset: 0, color: { value: "#000000" } },
    { offset: 1, color: { value: "#ffffff" } },
  ],
};

describe("渐变预设：内置", () => {
  it("6 套且都通过 core 的渐变校验", () => {
    expect(BUILTIN_GRADIENT_PRESETS).toHaveLength(6);
    for (const preset of BUILTIN_GRADIENT_PRESETS) {
      expect(tokenGradientOf(preset.value)).not.toBeNull();
      expect(preset.value.type).toBe("linear");
      expect(preset.key.startsWith("gradientPreset.")).toBe(true);
    }
  });

  it("名字不重复", () => {
    const keys = BUILTIN_GRADIENT_PRESETS.map((preset) => preset.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("渐变预设：用户列表", () => {
  it("读回时丢掉脏数据，超过上限截断", () => {
    expect(normalizePresets([linear, "x", { type: "linear" }])).toHaveLength(1);
    expect(normalizePresets(Array.from({ length: 40 }, () => linear))).toHaveLength(MAX_GRADIENT_PRESETS);
    expect(normalizePresets(null)).toEqual([]);
  });

  it("追加是拷贝，不是共享引用", () => {
    const list = appendPreset([], linear)!;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toBe(linear);
    expect(list[0]?.stops[0]).not.toBe(linear.stops[0]);
  });

  it("满了之后不再追加", () => {
    const full = Array.from({ length: MAX_GRADIENT_PRESETS }, () => linear);
    expect(appendPreset(full, linear)).toBeNull();
  });

  it("删除越界时保持原样", () => {
    expect(removePreset([linear], 3)).toHaveLength(1);
    expect(removePreset([linear], 0)).toHaveLength(0);
  });
});

describe("渐变预设：缩略条 CSS", () => {
  it("线性按方向给角度", () => {
    expect(previewCss(linear)).toBe("linear-gradient(90deg, #000000 0%, #ffffff 100%)");
  });

  it("径向 / 角度用对应 CSS，Token 色标退成中性灰", () => {
    expect(previewCss({ ...linear, type: "radial" })).toContain("radial-gradient(circle at 0% 50%");
    expect(previewCss({ ...linear, type: "angular" })).toContain("conic-gradient(");
    expect(
      previewCss({ ...linear, stops: [{ offset: 0, color: { token: "color/a" } }, linear.stops[1]!] }),
    ).toContain("#8a8fa3");
  });
});
