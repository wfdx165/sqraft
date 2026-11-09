/**
 * 节点效果：投影 / 内阴影 / 图层模糊 / 背景模糊（ADR-0018）。
 *
 * 这里是效果模型的纯数值部分：类型、默认值、外扩范围与降采样倍率。
 * 绘制（离屏合成、模糊、回读）属于渲染后端；本模块不得依赖 DOM。
 */

import type { Paint } from "./model";

export type EffectType = "drop-shadow" | "inner-shadow" | "layer-blur" | "backdrop-blur";

/** 阴影类效果：投影与内阴影共用参数。 */
export interface ShadowEffect {
  type: "drop-shadow" | "inner-shadow";
  visible: boolean;
  /** 偏移（文档单位，右下为正） */
  x: number;
  y: number;
  /** 模糊半径（文档单位） */
  blur: number;
  /** 扩散：正值外扩轮廓，负值内收 */
  spread: number;
  color: Paint;
}

/** 模糊类效果：图层模糊糊自身，背景模糊糊下层的已绘制内容。 */
export interface BlurEffect {
  type: "layer-blur" | "backdrop-blur";
  visible: boolean;
  /** 模糊半径（文档单位） */
  radius: number;
}

export type Effect = ShadowEffect | BlurEffect;

export const EFFECT_TYPES: readonly EffectType[] = ["drop-shadow", "inner-shadow", "layer-blur", "backdrop-blur"];

/** 离屏画布的长边上限（设备像素）：超过就按比例降采样，模糊本来就在抹细节。 */
export const EFFECT_LAYER_MAX_SIDE = 2048;

/** 默认阴影色：与页面投影一致的中性色（8 位 hex 便于取色器直接显示）。 */
export const DEFAULT_SHADOW_PAINT: Paint = { value: "#0f172a29" };

export const EFFECT_LABELS: Record<EffectType, string> = {
  "drop-shadow": "投影",
  "inner-shadow": "内阴影",
  "layer-blur": "图层模糊",
  "backdrop-blur": "背景模糊",
};

export function isShadowEffect(effect: Effect): effect is ShadowEffect {
  return effect.type === "drop-shadow" || effect.type === "inner-shadow";
}

export function isBlurEffect(effect: Effect): effect is BlurEffect {
  return effect.type === "layer-blur" || effect.type === "backdrop-blur";
}

/** 新加一条效果时的默认参数（颜色由调用方给出，缺省用中性阴影色）。 */
export function createEffect(type: EffectType, color: Paint = DEFAULT_SHADOW_PAINT): Effect {
  if (type === "drop-shadow") return { type, visible: true, x: 0, y: 4, blur: 12, spread: 0, color: { ...color } };
  if (type === "inner-shadow") return { type, visible: true, x: 0, y: 2, blur: 8, spread: 0, color: { ...color } };
  return { type, visible: true, radius: 8 };
}

/** 数值一律非负、有限；用于抹平 UI 输入与外部数据。 */
export function sanitizeEffect(effect: Effect): Effect {
  if (isShadowEffect(effect)) {
    return {
      ...effect,
      x: finite(effect.x, 0),
      y: finite(effect.y, 0),
      blur: Math.max(0, finite(effect.blur, 0)),
      spread: finite(effect.spread, 0),
    };
  }
  return { ...effect, radius: Math.max(0, finite(effect.radius, 0)) };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * `filter: blur(r)` 的可见扩散距离与 r 的比值。
 * Chromium 实测（r=10/20/40 → 22/45/89px）约 2.2；取 3 留跨引擎余量。
 * 投影与图层模糊共用这一个系数，避免两处外扩量漂移。
 */
export const BLUR_EXTENT = 3;

/**
 * 效果在文档单位下的外扩距离：离屏画布必须按它扩边，否则投影/模糊的软边会被硬切。
 * 各条效果依次施加，外扩量取累计和。
 * 输入只要求几何字段，因此核心模型与渲染层的“已解析颜色”版本都能直接复用。
 */
export interface EffectGeometry {
  type: EffectType;
  visible: boolean;
  x?: number;
  y?: number;
  blur?: number;
  spread?: number;
  radius?: number;
  /** 颜色不参与外扩计算，但允许直接传完整的模型效果（含 Paint 或已解析的字符串）。 */
  color?: unknown;
}

export function effectPadding(effects: readonly EffectGeometry[] | undefined): number {
  if (!effects || effects.length === 0) return 0;
  let pad = 0;
  for (const effect of effects) {
    if (!effect.visible) continue;
    if (effect.type === "drop-shadow") {
      const dist = Math.hypot(effect.x ?? 0, effect.y ?? 0);
      pad += Math.max(0, effect.blur ?? 0) * BLUR_EXTENT + dist + Math.abs(effect.spread ?? 0);
    } else if (effect.type === "layer-blur") {
      pad += Math.max(0, effect.radius ?? 0) * BLUR_EXTENT;
    }
    // 内阴影与背景模糊都只作用在节点形状内部，不需要外扩
  }
  return pad > 0 ? Math.ceil(pad) : 0;
}

/** 是否有任何可见效果（决定要不要为这个节点开离屏）。 */
export function hasVisibleEffects(effects: readonly Effect[] | undefined): boolean {
  return Boolean(effects?.some((e) => e.visible));
}

/**
 * 离屏画布的采样倍率（设备像素 / 文档单位）。
 * 正常情况下等于 deviceScale；长边超过上限时按比例降采样。
 */
export function effectLayerScale(
  width: number,
  height: number,
  deviceScale: number,
  maxSide: number = EFFECT_LAYER_MAX_SIDE,
): number {
  const maxWorld = Math.max(1, Math.abs(width), Math.abs(height));
  const wanted = Math.max(0.0001, deviceScale);
  const scaled = maxWorld * wanted;
  return scaled <= maxSide ? wanted : maxSide / maxWorld;
}
