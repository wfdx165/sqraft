<script setup lang="ts">
/**
 * 设置的统一外壳：左侧分类、右侧内容。
 * 四个分类用 v-show 常驻，切走再切回来不会重新挂载 —— MCP 客户端检测因此每个会话只跑一次。
 */
import { onBeforeUnmount, onMounted } from "vue";
import { closeSettings, SETTINGS_SECTIONS, settingsUi, type SettingsSection } from "../settings";
import { t } from "../i18n";
import GeneralSection from "./settings/GeneralSection.vue";
import AdvancedSection from "./settings/AdvancedSection.vue";
import McpSetupPanel from "./McpSetupPanel.vue";
import ShortcutsPanel from "./ShortcutsPanel.vue";

const LABEL_KEYS: Record<SettingsSection, Parameters<typeof t>[0]> = {
  general: "settings.section.general",
  mcp: "mcp.title",
  shortcuts: "shortcuts.title",
  advanced: "settings.section.advanced",
};

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") closeSettings();
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="settings-overlay" @click.self="closeSettings">
    <div class="settings-dialog glass" role="dialog" :aria-label="t('settings.title')">
      <header class="head">
        <span class="title">{{ t("settings.title") }}</span>
        <button class="close" :aria-label="t('common.close')" @click="closeSettings">✕</button>
      </header>

      <div class="body">
        <nav class="nav" aria-label="settings">
          <button
            v-for="section in SETTINGS_SECTIONS"
            :key="section"
            class="nav-item"
            :class="{ on: settingsUi.section === section }"
            @click="settingsUi.section = section"
          >
            {{ t(LABEL_KEYS[section]) }}
          </button>
        </nav>

        <div class="content">
          <GeneralSection v-show="settingsUi.section === 'general'" />
          <McpSetupPanel v-show="settingsUi.section === 'mcp'" embedded />
          <ShortcutsPanel v-show="settingsUi.section === 'shortcuts'" embedded />
          <AdvancedSection v-show="settingsUi.section === 'advanced'" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: var(--mask);
  backdrop-filter: blur(2px);
}

.settings-dialog {
  width: min(720px, calc(100vw - 48px));
  height: min(660px, calc(100vh - 80px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--radius-lg);
  border: 1px solid var(--hairline);
  background: var(--glass-strong);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--hairline);
}

.title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  padding: 4px 6px;
  border-radius: 6px;
}

.close:hover {
  background: var(--tint-5);
  color: var(--text);
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.nav {
  flex: none;
  width: 152px;
  padding: 12px 8px;
  border-right: 1px solid var(--hairline);
  background: var(--tint-4);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.nav-item {
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: 7px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.nav-item:hover {
  color: var(--text);
}

.nav-item.on {
  background: var(--glass-strong);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}

.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 18px 22px 22px;
}
</style>
