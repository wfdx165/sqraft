<script setup lang="ts">
/** 导出 PNG：选倍率 → 渲染 → 系统保存框。 */
import { computed, ref } from "vue";
import { exportUi, hooks } from "../store";
import { fileState } from "../file-session";
import { pngFileName } from "../export-name";
import { t } from "../i18n";

const busy = ref(false);
const error = ref("");

/** 建议文件名：文档名；系统保存框里还能改。 */
const suggestedName = computed(() => pngFileName(fileState.name, ""));

function close(): void {
  exportUi.open = false;
  error.value = "";
}

async function run(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const dataUrl = await hooks.renderExport({ scale: exportUi.scale });
    if (!dataUrl) {
      error.value = t("export.nothing");
      return;
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const result = await window.sqraft.file.exportPng({ suggestedName: suggestedName.value, bytes });
    if (result.status === "error") error.value = result.message;
    else close();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="scrim" @click.self="close">
    <div class="sheet glass" role="dialog" :aria-label="t('export.title')">
      <header>
        <span class="title">{{ t("export.title") }}</span>
        <button class="close" @click="close">✕</button>
      </header>

      <div class="row">
        <span class="label">{{ t("export.scale") }}</span>
        <div class="scales">
          <button
            v-for="scale in [1, 2, 3]"
            :key="scale"
            class="scale"
            :class="{ on: exportUi.scale === scale }"
            @click="exportUi.scale = scale"
          >
            {{ scale }}×
          </button>
        </div>
      </div>

      <p class="hint">{{ t("export.hint") }}</p>
      <p v-if="error" class="error">{{ error }}</p>

      <footer>
        <button class="ghost" @click="close">{{ t("common.cancel") }}</button>
        <button class="primary" :disabled="busy" @click="run">{{ busy ? t("export.exporting") : t("export.export") }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.18);
}

.sheet {
  width: 320px;
  padding: 14px 16px 12px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--hairline);
  background: var(--surface);
  box-shadow: var(--shadow-float);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title {
  font-size: 13px;
  font-weight: 600;
}

.close {
  border: 0;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.label {
  font-size: 11px;
  color: var(--text-dim);
}

.scales {
  display: flex;
  gap: 4px;
}

.scale {
  min-width: 44px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline);
  background: transparent;
  font-size: 11px;
  cursor: pointer;
  color: var(--text-dim);
}

.scale.on {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent);
}

.hint {
  margin: 0;
  font-size: 10.5px;
  color: var(--text-faint);
  line-height: 1.5;
}

.error {
  margin: 0;
  font-size: 11px;
  color: var(--danger);
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 2px;
}

.ghost,
.primary {
  padding: 5px 12px;
  border-radius: var(--radius-pill);
  font-size: 11.5px;
  cursor: pointer;
}

.ghost {
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
}

.primary {
  border: 1px solid var(--accent-line);
  background: var(--accent);
  color: #fff;
}

.primary:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
