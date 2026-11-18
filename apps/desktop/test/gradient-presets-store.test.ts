import { beforeEach, describe, expect, it } from "vitest";
import type { GradientValue } from "@sqraft/core";
import { MAX_GRADIENT_PRESETS } from "../src/renderer/gradient-presets";
import { deletePreset, loadPresetsOnce, presets, savePreset } from "../src/renderer/gradient-presets-store";

const linear: GradientValue = {
  type: "linear",
  from: { x: 0, y: 0.5 },
  to: { x: 1, y: 0.5 },
  stops: [
    { offset: 0, color: { value: "#000000" } },
    { offset: 1, color: { value: "#ffffff" } },
  ],
};

interface Bridge {
  list: unknown[];
  fail?: boolean;
  writes: number;
}

/** 装一个最小 `window.sqraft.prefs` 桥，模拟主进程的读写。 */
function installBridge(initial: unknown[] = []): Bridge {
  const bridge: Bridge = { list: [...initial], writes: 0 };
  (globalThis as unknown as { window: unknown }).window = {
    sqraft: {
      prefs: {
        gradientPresets: async () => bridge.list,
        setGradientPresets: async (next: unknown[]) => {
          bridge.writes += 1;
          if (bridge.fail) throw new Error("disk full");
          bridge.list = [...next];
          return bridge.list;
        },
      },
    },
  };
  return bridge;
}

describe("渐变预设 store", () => {
  beforeEach(() => {
    presets.value = [];
  });

  it("首次加载会丢掉脏数据（与纯函数共用同一套校验）", async () => {
    installBridge([linear, "nope", { type: "linear" }]);
    await loadPresetsOnce();
    expect(presets.value).toHaveLength(1);
  });

  it("保存成功后共享列表立即更新", async () => {
    const bridge = installBridge([]);
    expect(await savePreset(linear)).toBe("ok");
    expect(presets.value).toHaveLength(1);
    expect(bridge.writes).toBe(1);
    expect(bridge.list).toHaveLength(1);
  });

  it("满了返回 full，且不会写盘", async () => {
    const bridge = installBridge([]);
    presets.value = Array.from({ length: MAX_GRADIENT_PRESETS }, () => linear);
    expect(await savePreset(linear)).toBe("full");
    expect(bridge.writes).toBe(0);
  });

  it("写盘失败返回 error，列表保持原样", async () => {
    const bridge = installBridge([linear]);
    presets.value = [linear];
    bridge.fail = true;
    expect(await savePreset(linear)).toBe("error");
    expect(presets.value).toHaveLength(1);
  });

  it("删除按下标移除并落盘", async () => {
    installBridge([linear, linear]);
    presets.value = [linear, linear];
    expect(await deletePreset(1)).toBe(true);
    expect(presets.value).toHaveLength(1);
  });
});
