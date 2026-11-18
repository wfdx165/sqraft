<script setup lang="ts">
/**
 * 「高级」分类：数据目录、自动下载开关与两个排障动作。
 * 日志与缓存没有渲染层 IPC，直接走已有的 runCommand 白名单；
 * 缓存结果对话框由主进程负责，与菜单入口是同一条路径。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { AppInfo } from "../../../shared/ipc";
import { t } from "../../i18n";
import { setAutoDownload, updateUi } from "../../update";

const info = ref<AppInfo | null>(null);
const copied = ref(false);
const switching = ref(false);
let copiedTimer = 0;

onMounted(async () => {
  info.value = await window.sqraft.app.info();
});

onBeforeUnmount(() => window.clearTimeout(copiedTimer));

function copyPath(): void {
  if (!info.value) return;
  window.sqraft.app.copyText(info.value.dataPath);
  copied.value = true;
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => (copied.value = false), 1400);
}

async function toggleAutoDownload(): Promise<void> {
  if (switching.value) return;
  switching.value = true;
  try {
    await setAutoDownload(!updateUi.autoDownload);
  } finally {
    switching.value = false;
  }
}

function run(id: "app.openLogsDir" | "app.clearImageCache"): void {
  void window.sqraft.app.runCommand(id);
}
</script>

<template>
  <div class="advanced">
    <p class="hint">{{ t("settings.advanced.hint") }}</p>

    <section>
      <div class="label">
        <span>{{ t("settings.autoDownload") }}</span>
        <button class="action" :disabled="switching" @click="toggleAutoDownload">
          {{ updateUi.autoDownload ? t("settings.autoDownloadOn") : t("settings.autoDownloadOff") }}
        </button>
      </div>
      <p class="hint">{{ t("settings.autoDownloadHint") }}</p>
    </section>

    <section>
      <div class="label">
        <span>{{ t("about.dataDir") }}</span>
        <button class="action" @click="copyPath">{{ copied ? t("common.copied") : t("about.copyPath") }}</button>
      </div>
      <p class="path">{{ info?.dataPath ?? "—" }}</p>
    </section>

    <section>
      <div class="label"><span>{{ t("menu.openLogs") }}</span></div>
      <button class="action wide" @click="run('app.openLogsDir')">{{ t("menu.openLogs") }}</button>
    </section>

    <section>
      <div class="label"><span>{{ t("menu.clearImageCache") }}</span></div>
      <button class="action wide" @click="run('app.clearImageCache')">{{ t("menu.clearImageCache") }}</button>
    </section>
  </div>
</template>

<style scoped>
.hint {
  margin: 0 0 16px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}

section + section {
  margin-top: 18px;
}

.label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-faint);
  margin-bottom: 6px;
}

.action {
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  padding: 3px 9px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

.action:hover {
  color: var(--text);
  border-color: var(--hairline-strong);
}

.action:disabled {
  opacity: 0.5;
  cursor: default;
}

.action.wide {
  width: 100%;
  padding: 7px 10px;
  text-align: left;
}

.path {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--tint-4);
  border: 1px solid var(--hairline);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  word-break: break-all;
}
</style>
