<script setup lang="ts">
/** 接入引导：三条示例 prompt；面板里展开正文，欢迎页只给标题与复制。 */
import { ref } from "vue";
import { EXAMPLE_PROMPTS, type ExamplePrompt } from "../examples/prompts";
import { t } from "../i18n";

defineProps<{ compact?: boolean }>();

const copied = ref<string | null>(null);

function copy(prompt: ExamplePrompt): void {
  window.sqraft.app.copyText(prompt.text);
  copied.value = prompt.id;
  window.setTimeout(() => {
    if (copied.value === prompt.id) copied.value = null;
  }, 1400);
}
</script>

<template>
  <div class="prompt-list" :class="{ compact }">
    <div v-for="prompt in EXAMPLE_PROMPTS" :key="prompt.id" class="prompt">
      <div class="head">
        <span class="title">{{ t(prompt.titleKey) }}</span>
        <button class="copy" @click="copy(prompt)">
          {{ copied === prompt.id ? t("common.copied") : t("onboarding.copy") }}
        </button>
      </div>
      <p class="desc">{{ t(prompt.descKey) }}</p>
      <pre v-if="!compact" class="body">{{ prompt.text }}</pre>
    </div>
  </div>
</template>

<style scoped>
.prompt-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.prompt {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.title {
  font-size: 12px;
  color: var(--text);
}

.copy {
  flex: none;
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  padding: 2px 8px;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.copy:hover {
  color: var(--text);
  border-color: var(--hairline-strong);
}

.desc {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.5;
}

.body {
  margin: 2px 0 0;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline);
  background: var(--tint-4);
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}

.compact .desc {
  display: none;
}
</style>
