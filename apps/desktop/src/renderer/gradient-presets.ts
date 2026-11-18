/**
 * 渐变预设（R17）：内置 6 套 + 用户自己存的（偏好，不进文档）。
 *
 * 这里是纯逻辑：值的形状校验交给 core 的 `tokenGradientOf`，
 * 本机存取走 `window.sqraft.prefs`（主进程只夹上限、负责落盘）。
 */
import { cloneGradientValue, tokenGradientOf, type GradientValue } from "@sqraft/core";
import type { MessageKey } from "../shared/i18n";

/** 用户预设上限：满了提示先删，不做静默淘汰（预设是用户资产）。 */
export const MAX_GRADIENT_PRESETS = 24;

export interface BuiltinGradientPreset {
  /** 名称走 i18n；色值不翻译 */
  key: MessageKey;
  value: GradientValue;
}

function horizontal(stops: Array<[number, string]>): GradientValue {
  return {
    type: "linear",
    from: { x: 0, y: 0.5 },
    to: { x: 1, y: 0.5 },
    stops: stops.map(([offset, value]) => ({ offset, color: { value } })),
  };
}

/** 内置预设：统一横向线性，点击即完整替换（类型 + 方向 + 色标）。 */
export const BUILTIN_GRADIENT_PRESETS: readonly BuiltinGradientPreset[] = [
  { key: "gradientPreset.neutral", value: horizontal([[0, "#f5f7fa"], [1, "#cbd5e1"]]) },
  { key: "gradientPreset.blueViolet", value: horizontal([[0, "#6366f1"], [1, "#a855f7"]]) },
  { key: "gradientPreset.sunset", value: horizontal([[0, "#f97316"], [1, "#db2777"]]) },
  { key: "gradientPreset.mint", value: horizontal([[0, "#34d399"], [1, "#0ea5e9"]]) },
  { key: "gradientPreset.neon", value: horizontal([[0, "#22d3ee"], [1, "#a3e635"]]) },
  {
    key: "gradientPreset.metal",
    value: horizontal([
      [0, "#f8fafc"],
      [0.5, "#94a3b8"],
      [1, "#475569"],
    ]),
  },
];

/** 从偏好读回来的值：逐个校验，脏数据直接丢掉，不阻断其它预设。 */
export function normalizePresets(value: unknown): GradientValue[] {
  if (!Array.isArray(value)) return [];
  const out: GradientValue[] = [];
  for (const item of value) {
    const gradient = tokenGradientOf(item);
    if (!gradient) continue;
    out.push(gradient);
    if (out.length >= MAX_GRADIENT_PRESETS) break;
  }
  return out;
}

/** 追加一条；已满返回 null（调用方提示先删）。 */
export function appendPreset(list: readonly GradientValue[], value: GradientValue): GradientValue[] | null {
  if (list.length >= MAX_GRADIENT_PRESETS) return null;
  return [...list, cloneGradientValue(value)];
}

/** 删除指定下标；越界返回原数组。 */
export function removePreset(list: readonly GradientValue[], index: number): GradientValue[] {
  if (index < 0 || index >= list.length) return [...list];
  return list.filter((_, i) => i !== index);
}

/** 列表缩略条用的 CSS：Token 色标取不到具体色时用中性灰示意。 */
export function previewCss(value: GradientValue): string {
  const stops = value.stops
    .map((stop) => `${stop.color.value ?? "#8a8fa3"} ${Math.round(Math.min(1, Math.max(0, stop.offset)) * 100)}%`)
    .join(", ");
  if (value.type === "radial") {
    return `radial-gradient(circle at ${Math.round(value.from.x * 100)}% ${Math.round(value.from.y * 100)}%, ${stops})`;
  }
  if (value.type === "angular") return `conic-gradient(${stops})`;
  const dx = value.to.x - value.from.x;
  const dy = value.to.y - value.from.y;
  const angle = Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
  return `linear-gradient(${angle}deg, ${stops})`;
}

/** 读本机预设；桥不可用（测试 / 早期启动）时返回空数组。 */
export async function loadGradientPresets(): Promise<GradientValue[]> {
  try {
    return normalizePresets(await window.sqraft.prefs.gradientPresets());
  } catch {
    return [];
  }
}

/** 写本机预设；返回主进程夹取后的结果。失败时抛错，由调用方提示。 */
export async function saveGradientPresets(list: readonly GradientValue[]): Promise<GradientValue[]> {
  return normalizePresets(await window.sqraft.prefs.setGradientPresets([...list]));
}
