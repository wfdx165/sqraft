<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { LANGUAGE_PREFERENCES, localeLabel, type LanguagePreference } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import { languagePreference, locale, setLanguage, t } from "../i18n";
import { showToast } from "../toast";

const emit = defineEmits<{ close: [] }>();
const busy = ref(false);

interface Option {
  value: LanguagePreference;
  label: string;
  /** 自动选项右侧显示当前解析到的语言 */
  detail?: string;
}

const LABEL_KEYS: Record<LanguagePreference, MessageKey> = {
  auto: "settings.languageAuto",
  "zh-CN": "settings.languageZh",
  "en-US": "settings.languageEn",
  "ja-JP": "settings.languageJa",
  "ko-KR": "settings.languageKo",
};

const options = computed<Option[]>(() =>
  LANGUAGE_PREFERENCES.map((value) => ({
    value,
    label: t(LABEL_KEYS[value]),
    ...(value === "auto" ? { detail: localeLabel(locale.value) } : {}),
  })),
);

async function choose(next: LanguagePreference): Promise<void> {
  if (busy.value || languagePreference.value === next) return;
  busy.value = true;
  try {
    await setLanguage(next);
  } catch {
    showToast(t("settings.languageFailed"), "error");
  } finally {
    busy.value = false;
  }
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="panel glass">
      <header>
        <h2>{{ t("settings.title") }}</h2>
        <button class="icon" :title="t('common.close')" @click="$emit('close')">✕</button>
      </header>

      <section>
        <div class="label">{{ t("settings.language") }}</div>
        <div class="options">
          <button
            v-for="option in options"
            :key="option.value"
            class="option"
            :class="{ active: languagePreference === option.value }"
            :disabled="busy"
            @click="choose(option.value)"
          >
            <span class="option-label">{{ option.label }}</span>
            <span class="option-side">
              <span v-if="option.detail" class="option-detail">{{ option.detail }}</span>
              <span v-if="languagePreference === option.value" class="check" aria-hidden="true">✓</span>
            </span>
          </button>
        </div>
        <p class="hint">{{ t("settings.languageCurrent", { language: localeLabel(locale) }) }}</p>
        <p class="hint">{{ t("settings.languageHint") }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: var(--mask);
  backdrop-filter: blur(2px);
}

.panel {
  width: min(420px, calc(100vw - 48px));
  padding: 22px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--hairline);
  background: var(--glass-strong);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.icon {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  padding: 4px 6px;
  border-radius: 6px;
}

.icon:hover {
  background: var(--tint-5);
  color: var(--text);
}

.label {
  font-size: 11px;
  color: var(--text-faint);
  margin-bottom: 8px;
}

.options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
  border-radius: 7px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.option:hover {
  color: var(--text);
  border-color: var(--hairline-strong);
}

.option.active {
  color: var(--text);
  border-color: var(--accent);
  background: var(--tint-4);
}

.option:disabled {
  opacity: 0.5;
  cursor: default;
}

.option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-side {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.option-detail {
  color: var(--text-faint);
  font-size: 11px;
}

.check {
  color: var(--accent);
  font-size: 12px;
}

.hint {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}
</style>
