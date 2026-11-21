<script setup lang="ts">
/**
 * 结构化渐变编辑器：类型 / 角度或中心+半径 / 色标列表。
 * 交给父层的 `change` 是整体替换（撤销依赖"patch.style 整体替换"）。
 */
import { computed } from "vue";
import type { GradientPaint, GradientStop } from "@sqraft/core";
import { t } from "../i18n";

const props = defineProps<{ paint: GradientPaint; disabled?: boolean }>();
import { computed, onMounted, ref } from "vue";
import { cloneGradientValue, type GradientPaint, type GradientStop, type GradientValue } from "@sqraft/core";
import { t } from "../i18n";
import { BUILTIN_GRADIENT_PRESETS, MAX_GRADIENT_PRESETS, previewCss } from "../gradient-presets";
import { deletePreset, loadPresetsOnce, presets, savePreset } from "../gradient-presets-store";

const props = defineProps<{
  paint: GradientPaint;
  disabled?: boolean;
  /** 可选的纯色 Token（色标可以引用它们） */
  colorTokens?: string[];
  /** 把 Token 解析成颜色：从 Token 切回字面量时起点色用它，避免跳成黑色 */
  colorOfToken?: (path: string) => string;
}>();
const emit = defineEmits<{ change: [GradientPaint] }>();

const angle = computed(() => {
  const dx = props.paint.to.x - props.paint.from.x;
  const dy = props.paint.to.y - props.paint.from.y;
  return Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
});

const radius = computed(() => {
  const dx = props.paint.to.x - props.paint.from.x;
  const dy = props.paint.to.y - props.paint.from.y;
  return Math.max(0.01, Math.round(Math.hypot(dx, dy) * 100) / 100);
});

/* ---------- 预设 ---------- */

const presetError = ref("");

onMounted(() => {
  void loadPresetsOnce();
});

function applyPreset(value: GradientValue): void {
  if (props.disabled) return;
  emit("change", cloneGradientValue(value));
}

async function saveAsPreset(): Promise<void> {
  if (props.disabled) return;
  const result = await savePreset(props.paint);
  if (result === "full") {
    presetError.value = t("inspector.gradientPresetFull", { max: MAX_GRADIENT_PRESETS });
    return;
  }
  presetError.value = result === "ok" ? "" : t("inspector.gradientPresetSaveFailed");
}

async function removeAt(index: number): Promise<void> {
  presetError.value = (await deletePreset(index)) ? "" : t("inspector.gradientPresetSaveFailed");
}

function unit(): { x: number; y: number } {
  const dx = props.paint.to.x - props.paint.from.x;
  const dy = props.paint.to.y - props.paint.from.y;
  const len = Math.hypot(dx, dy);
  return len > 0 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
}

function update(patch: Partial<GradientPaint>): void {
  emit("change", { ...props.paint, ...patch });
}

function setType(event: Event): void {
  const type = (event.target as HTMLSelectElement).value as GradientPaint["type"];
  if (type === props.paint.type) return;
  update(
    type === "linear"
      ? { type, from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 } }
      : { type, from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 } },
  );
}

function setAngle(event: Event): void {
  const deg = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(deg)) return;
  const rad = (deg * Math.PI) / 180;
  const len = radius.value;
  update({
    to: { x: props.paint.from.x + Math.cos(rad) * len, y: props.paint.from.y + Math.sin(rad) * len },
  });
}

function setCenter(axis: "x" | "y", event: Event): void {
  const percent = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(percent)) return;
  const next = { ...props.paint.from, [axis]: Math.min(100, Math.max(0, percent)) / 100 };
  const dx = props.paint.to.x - props.paint.from.x;
  const dy = props.paint.to.y - props.paint.from.y;
  update({ from: next, to: { x: next.x + dx, y: next.y + dy } });
}

function setRadius(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value) || value <= 0) return;
  const u = unit();
  update({ to: { x: props.paint.from.x + u.x * value, y: props.paint.from.y + u.y * value } });
}

function stopsWith(index: number, stop: GradientStop): GradientStop[] {
  return props.paint.stops.map((entry, i) => (i === index ? stop : entry));
}

function setOffset(index: number, event: Event): void {
  const percent = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(percent)) return;
  const offset = Math.min(100, Math.max(0, percent)) / 100;
  const stops = stopsWith(index, { ...props.paint.stops[index]!, offset }).sort((a, b) => a.offset - b.offset);
  update({ stops });
}

function setColor(index: number, event: Event): void {
  const value = (event.target as HTMLInputElement).value.trim();
  if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) return;
  const stop = props.paint.stops[index];
  if (!stop || stop.color.token) return;
  update({ stops: stopsWith(index, { ...stop, color: { value } }) });
}

function setStopToken(index: number, event: Event): void {
  const stop = props.paint.stops[index];
  if (!stop) return;
  const token = (event.target as HTMLSelectElement).value;
  if (token) {
    update({ stops: stopsWith(index, { ...stop, color: { token } }) });
    return;
  }
  const literal = stop.color.value ?? props.colorOfToken?.(stop.color.token ?? "") ?? "#000000";
  update({ stops: stopsWith(index, { ...stop, color: { value: literal } }) });
}

function addStop(): void {
  if (props.paint.stops.length >= 16) return;
  const last = props.paint.stops[props.paint.stops.length - 1];
  const prev = props.paint.stops[props.paint.stops.length - 2];
  const offset = last && prev ? (last.offset + prev.offset) / 2 : 0.5;
  const color = last?.color ?? { value: "#ffffff" };
  update({ stops: [...props.paint.stops, { offset, color: { ...color } }] });
}

function removeStop(index: number): void {
  if (props.paint.stops.length <= 2) return;
  update({ stops: props.paint.stops.filter((_, i) => i !== index) });
}

function hexOf(color: GradientStop["color"]): string {
  return /^#[0-9a-fA-F]{6,8}$/.test(color.value ?? "") ? (color.value as string).slice(0, 7) : "#000000";
}
</script>

<template>
  <div class="gradient">
    <div class="presets">
      <button
        v-for="preset in BUILTIN_GRADIENT_PRESETS"
        :key="preset.key"
        type="button"
        class="preset"
        :style="{ background: previewCss(preset.value) }"
        :title="t(preset.key)"
        :disabled="disabled"
        @click="applyPreset(preset.value)"
      />
      <span v-for="(preset, index) in presets" :key="'preset-' + index" class="preset-wrap">
        <button
          type="button"
          class="preset"
          :style="{ background: previewCss(preset) }"
          :title="t('inspector.gradientPresetN', { n: index + 1 })"
          :disabled="disabled"
          @click="applyPreset(preset)"
        />
        <button
          type="button"
          class="preset-remove"
          :title="t('inspector.gradientPresetRemove')"
          :disabled="disabled"
          @click.stop="removeAt(index)"
        >
          ×
        </button>
      </span>
      <button
        type="button"
        class="preset add"
        :title="t('inspector.gradientSavePreset')"
        :disabled="disabled"
        @click="saveAsPreset"
      >
        ＋
      </button>
    </div>
    <p v-if="presetError" class="preset-error">{{ presetError }}</p>

    <div class="g-row">
      <label>{{ t("inspector.gradientType") }}</label>
      <select :value="paint.type" :disabled="disabled" @change="setType">
        <option value="linear">{{ t("inspector.gradientLinear") }}</option>
        <option value="radial">{{ t("inspector.gradientRadial") }}</option>
        <option value="angular">{{ t("inspector.gradientAngular") }}</option>
        <option value="diamond">{{ t("inspector.gradientDiamond") }}</option>
      </select>
    </div>

    <div v-if="paint.type === 'linear'" class="g-row">
      <label>{{ t("inspector.gradientAngle") }}</label>
      <input class="mono" type="number" step="5" :value="angle" :disabled="disabled" @change="setAngle" />
    </div>
    <template v-else>
      <div class="g-row">
        <label>{{ t("inspector.gradientCenter") }}</label>
        <span class="pair">
          <input class="mono" type="number" min="0" max="100" :value="Math.round(paint.from.x * 100)" :disabled="disabled" @change="setCenter('x', $event)" />
          <input class="mono" type="number" min="0" max="100" :value="Math.round(paint.from.y * 100)" :disabled="disabled" @change="setCenter('y', $event)" />
        </span>
      </div>
      <div class="g-row">
        <label>{{ t("inspector.gradientRadius") }}</label>
        <input class="mono" type="number" min="0.01" max="2" step="0.05" :value="radius" :disabled="disabled" @change="setRadius" />
      </div>
    </template>

    <div v-for="(stop, index) in paint.stops" :key="index" class="g-row stop">
      <input
        class="mono offset"
        type="number"
        min="0"
        max="100"
        :value="Math.round(stop.offset * 100)"
        :disabled="disabled"
        @change="setOffset(index, $event)"
      />
      <select
        v-if="colorTokens && colorTokens.length > 0"
        class="stop-token"
        :value="stop.color.token ?? ''"
        :disabled="disabled"
        @change="setStopToken(index, $event)"
      >
        <option value="">{{ t("inspector.gradientStopLiteral") }}</option>
        <option v-for="path in colorTokens" :key="path" :value="path">{{ path }}</option>
      </select>
      <span v-else-if="stop.color.token" class="token mono">{{ stop.color.token }}</span>
      <template v-if="!stop.color.token">
        <input type="color" class="color-input" :value="hexOf(stop.color)" :disabled="disabled" @input="setColor(index, $event)" />
        <input class="mono hex" :value="stop.color.value ?? ''" :disabled="disabled" @change="setColor(index, $event)" />
      </template>
      <button class="mini" :disabled="disabled || paint.stops.length <= 2" :title="t('inspector.gradientRemoveStop')" @click="removeStop(index)">
        ×
      </button>
    </div>

    <button class="mini add" :disabled="disabled || paint.stops.length >= 16" @click="addStop">
      {{ t("inspector.gradientAddStop") }}
    </button>
  </div>
</template>

<style scoped>
.gradient {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 2px;
}

.preset {
  width: 22px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--hairline);
  border-radius: 5px;
  cursor: pointer;
  background-clip: padding-box;
}

.preset:disabled {
  opacity: 0.5;
  cursor: default;
}

.preset.add {
  border-style: dashed;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1;
}

.preset-wrap {
  position: relative;
  display: inline-flex;
}

.preset-remove {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 13px;
  height: 13px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-dim);
  box-shadow: 0 0 0 1px var(--hairline);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
}

.preset-wrap:hover .preset-remove {
  opacity: 1;
}

.preset-error {
  margin: 0 0 2px;
  font-size: 11px;
  color: var(--danger, #d64545);
}

.g-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
}

.g-row label {
  flex: 0 0 68px;
  color: var(--text-faint);
}

.g-row select,
.g-row input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--hairline);
  background: var(--surface);
  color: var(--text);
  border-radius: 5px;
  padding: 3px 6px;
  font-family: inherit;
  font-size: 11px;
}

.pair {
  display: flex;
  gap: 4px;
  flex: 1;
}

.pair input {
  width: 50%;
  flex: none;
}

.stop .offset {
  flex: 0 0 56px;
}

.stop .hex {
  flex: 1;
}

.stop .stop-token {
  flex: 1;
  min-width: 0;
}

.stop .color-input {
  flex: 0 0 28px;
  padding: 0;
  height: 22px;
}

.token {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.mini {
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
  border-radius: 5px;
  padding: 2px 6px;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.mini.add {
  align-self: flex-start;
  margin-top: 2px;
}

.mini:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
