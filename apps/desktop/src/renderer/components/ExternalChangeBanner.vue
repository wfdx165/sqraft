<script setup lang="ts">
/**
 * 外部改动横幅（ADR-0041）：切到被外部改过的标签时浮在画布顶部。
 *
 * 只提示，不自动重载；「保留当前版本」不更新记住的 mtime，下次保存仍会走覆盖确认。
 */
import { computed } from "vue";
import { activeSession } from "../sessions";
import { ui } from "../store";
import { keepExternalChanges, reloadActiveDocument } from "../file-session";
import { t } from "../i18n";
import { tabLabel } from "../tab-label";

const tab = computed(() => (ui.docOpen ? activeSession() : null));
const visible = computed(() => Boolean(tab.value?.file.externalChange));
const missing = computed(() => Boolean(tab.value?.file.missing));
const name = computed(() => (tab.value ? tabLabel(tab.value) : t("common.untitled")));
</script>

<template>
  <div v-if="visible" class="banner glass">
    <span class="text">{{ missing ? t("external.missing", { name }) : t("external.changed", { name }) }}</span>
    <button v-if="!missing" class="action" @click="reloadActiveDocument">{{ t("external.reload") }}</button>
    <button class="action" @click="keepExternalChanges">{{ t("external.keep") }}</button>
  </div>
</template>

<style scoped>
.banner {
  position: absolute;
  top: 12px;
  left: 50%;
  translate: -50% 0;
  z-index: 14;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(680px, calc(100vw - 48px));
  padding: 8px 10px 8px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hairline);
  font-size: 12px;
  color: var(--text);
  animation: banner-in var(--dur-med) var(--ease);
}

.text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action {
  flex: none;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.action:hover {
  color: var(--text);
  border-color: var(--hairline-strong);
}

@keyframes banner-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
