/**
 * 渐变预设的共享状态：填充编辑器、描边编辑器与设计系统面板看到的必须是同一份。
 * 纯逻辑（归一化 / 追加 / 删除 / 缩略 CSS）留在 `gradient-presets.ts`。
 */
import { ref } from "vue";
import type { GradientValue } from "@sqraft/core";
import {
  appendPreset,
  loadGradientPresets,
  removePreset,
  saveGradientPresets,
} from "./gradient-presets";

/** 当前预设列表（内置预设不在这里）。 */
export const presets = ref<GradientValue[]>([]);

let loading: Promise<void> | null = null;

/** 只从偏好里读一次；失败当作空列表，不阻断编辑。 */
export function loadPresetsOnce(): Promise<void> {
  loading ??= loadGradientPresets().then((list) => {
    presets.value = list;
  });
  return loading;
}

export type PresetSaveResult = "ok" | "full" | "error";

/** 追加一条并落盘；满了返回 `full`，写失败返回 `error`（列表保持原样）。 */
export async function savePreset(value: GradientValue): Promise<PresetSaveResult> {
  const next = appendPreset(presets.value, value);
  if (!next) return "full";
  try {
    presets.value = await saveGradientPresets(next);
    return "ok";
  } catch {
    return "error";
  }
}

/** 删除指定下标；写失败返回 false（列表保持原样）。 */
export async function deletePreset(index: number): Promise<boolean> {
  try {
    presets.value = await saveGradientPresets(removePreset(presets.value, index));
    return true;
  } catch {
    return false;
  }
}
