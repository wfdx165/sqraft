<script setup lang="ts">
/**
 * 多倍率导出对话框：勾选 PNG 倍率与是否带 SVG，确认后一次渲染并选目录落盘。
 * 设置会由主进程写进偏好，下次打开沿用。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ExportSettings } from "../../shared/ipc";
import { t } from "../i18n";
import { exportSelectionMatrix } from "../canvas/export-selection";

const emit = defineEmits<{ close: [] }>();

const SCALES = [1, 2, 4] as const;

const scales = ref<Set<number>>(new Set([1, 2]));
const includeSvg = ref(false);
const busy = ref(false);

onMounted(async () => {
  try {
    const settings = await window.sqraft.file.exportSettings();
    scales.value = new Set(settings.scales.length ? settings.scales : [1, 2]);
    includeSvg.value = settings.includeSvg;
  } catch {
    // 读不到偏好就用默认值，不阻塞导出
  }
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape" && !busy.value) emit("close");
}

const canExport = computed(() => !busy.value && scales.value.size > 0);

function toggleScale(scale: number): void {
  if (busy.value) return;
  const next = new Set(scales.value);
  if (next.has(scale)) next.delete(scale);
  else next.add(scale);
  scales.value = next;
}

function toggleSvg(): void {
  if (busy.value) return;
  includeSvg.value = !includeSvg.value;
}

async function confirm(): Promise<void> {
  if (!canExport.value) return;
  busy.value = true;
  const settings: ExportSettings = {
    scales: [...scales.value].sort((a, b) => a - b),
    includeSvg: includeSvg.value,
  };
  const result = await exportSelectionMatrix(settings);
  busy.value = false;
  // 失败留在对话框里让用户调整；成功/取消都关掉
  if (result !== "error") emit("close");
}
</script>

<template>
  <div class="overlay" @click.self="!busy && emit('close')">
    <div class="panel glass" role="dialog" aria-modal="true">
      <header>
        <h2>{{ t("exportMatrix.title") }}</h2>
        <button class="icon" :disabled="busy" :title="t('common.close')" @click="emit('close')">✕</button>
      </header>

      <section>
        <div class="label">{{ t("exportMatrix.scales") }}</div>
        <div class="options">
          <button
            v-for="scale in SCALES"
            :key="scale"
            class="option"
            :class="{ active: scales.has(scale) }"
            :disabled="busy"
            @click="toggleScale(scale)"
          >
            <span class="check" aria-hidden="true">{{ scales.has(scale) ? "✓" : "" }}</span>
            <span>PNG {{ scale }}×</span>
          </button>
        </div>
      </section>

      <section>
        <button class="option wide" :class="{ active: includeSvg }" :disabled="busy" @click="toggleSvg">
          <span class="check" aria-hidden="true">{{ includeSvg ? "✓" : "" }}</span>
          <span>{{ t("exportMatrix.includeSvg") }}</span>
        </button>
      </section>

      <p class="hint">{{ t("exportMatrix.hint") }}</p>

      <footer>
        <button class="ghost" :disabled="busy" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="primary" :disabled="!canExport" @click="confirm">
          {{ busy ? t("exportMatrix.exporting") : t("exportMatrix.export") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.18);
  backdrop-filter: blur(2px);
}

.panel {
  width: 360px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--hairline-strong);
  background: var(--surface);
  box-shadow: var(--shadow-float);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.icon {
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 12px;
}

.icon:disabled,
.option:disabled,
button:disabled {
  opacity: 0.5;
  cursor: default;
}

.label {
  font-size: 11px;
  color: var(--text-faint);
  margin-bottom: 6px;
}

.options {
  display: flex;
  gap: 6px;
}

.option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
  border-radius: 7px;
  padding: 7px 10px;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.option.wide {
  width: 100%;
  text-align: left;
}

.option.active {
  color: var(--text);
  border-color: var(--accent);
  background: var(--tint-4);
}

.check {
  width: 12px;
  color: var(--accent);
  font-size: 11px;
}

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.ghost,
.primary {
  border-radius: 7px;
  padding: 7px 14px;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ghost {
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
}

.primary {
  border: 1px solid transparent;
  background: var(--accent);
  color: #fff;
}
</style>
