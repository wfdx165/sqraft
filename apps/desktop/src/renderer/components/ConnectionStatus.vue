<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { isCrossPage } from "../canvas/agent-activity";
import { visibleClients } from "../connection-status";
import { mcpUi, refreshMcpStatus } from "../mcp-host";
import { t } from "../i18n";
import { hooks, ui } from "../store";

const open = ref(false);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

const count = computed(() => mcpUi.clients.length);
/** 浮层最多列 5 行，其余只报数量 */
const visible = computed(() => visibleClients(mcpUi.clients));

/**
 * 胶囊文案优先级：正在写的工具 > 正在读 > 刚改完的残留 > 连接数。
 * 写与读共用 `busy`，靠 `activity.running` 区分（activity 只由写工具产生）。
 */
const summary = computed(() => {
  const activity = mcpUi.activity;
  if (activity?.running) return `${activity.label} · ${activity.tool}`;
  if (mcpUi.busy) return t("conn.busyRead");
  if (activity) {
    if (!activity.pageId) return t("conn.changed", { label: activity.label });
    const crossPage = isCrossPage(activity.pageId, ui.activePageId, ui.mode === "edit");
    return crossPage
      ? t("conn.changedOtherPage", { label: activity.label, page: activity.pageName ?? t("conn.otherPage") })
      : t("conn.changedThisPage", { label: activity.label });
  }
  return t("conn.connectedCount", { count: count.value });
});

/** 改动看不见时给一个跳转入口：跨页报页面名，同页视口外只说"在视口外" */
const jumpLabel = computed(() => {
  const activity = mcpUi.activity;
  if (!activity?.offscreen) return "";
  const crossPage = isCrossPage(activity.pageId, ui.activePageId, ui.mode === "edit");
  return crossPage
    ? t("conn.pageJump", { page: activity.pageName ?? t("conn.otherPage") })
    : t("conn.offscreen");
});

function reveal(): void {
  open.value = false;
  hooks.revealAgentActivity();
}

/** 连接时长：只在浮层打开时刷新，避免常驻定时器 */
function durationOf(connectedAt: number): string {
  const seconds = Math.max(0, Math.round((now.value - connectedAt) / 1000));
  if (seconds < 60) return t("conn.seconds", { n: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("conn.minutes", { n: minutes });
  return t("conn.hours", { n: Math.round(minutes / 60) });
}

function toolLabel(client: { lastTool?: string; lastToolAt?: number }): string {
  if (!client.lastTool) return t("conn.noTool");
  const seconds = Math.max(0, Math.round((now.value - (client.lastToolAt ?? now.value)) / 1000));
  return `${client.lastTool} · ${
    seconds < 60 ? t("conn.secondsAgo", { n: seconds }) : t("conn.minutesAgo", { n: Math.round(seconds / 60) })
  }`;
}

function toggle(): void {
  open.value = !open.value;
  now.value = Date.now();
  refreshMcpStatus();
  if (timer) clearInterval(timer);
  timer = null;
  if (open.value) {
    timer = setInterval(() => {
      now.value = Date.now();
      // 最近一次工具调用只存在主进程里：打开详情时每 5s 拉一次
      refreshMcpStatus();
    }, 5000);
  }
}

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div v-if="count > 0 || mcpUi.activity" class="conn-wrap">
    <div class="conn-top">
      <button class="conn-status glass" :class="{ open }" role="status" @click="toggle">
        <span class="dot" :class="{ busy: mcpUi.busy }" />
        <span class="text">{{ summary }}</span>
        <span class="hint">{{ open ? t("conn.collapse") : t("conn.details") }}</span>
      </button>
      <button v-if="jumpLabel" class="conn-jump glass" :title="jumpLabel" @click="reveal">
        {{ jumpLabel }}
      </button>
    </div>

    <div v-if="open" class="conn-list glass">
      <div v-for="client in visible.rows" :key="client.id" class="conn-row">
        <span class="conn-label">{{ client.label }}</span>
        <span class="conn-meta">{{ t("conn.connectedFor", { duration: durationOf(client.connectedAt) }) }}</span>
        <span class="conn-tool">{{ toolLabel(client) }}</span>
      </div>
      <div v-if="visible.more > 0" class="conn-more">{{ t("conn.more", { count: visible.more }) }}</div>
    </div>
  </div>
</template>

<style scoped>
.conn-wrap {
  position: absolute;
  top: 64px;
  left: 50%;
  translate: -50% 0;
  z-index: 9;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.conn-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.conn-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--hairline);
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  cursor: pointer;
  background: transparent;
}

.conn-status.open {
  border-color: var(--accent-line);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
}

.dot.busy {
  background: var(--accent);
  animation: pulse 1s ease-in-out infinite;
}

.hint {
  color: var(--text-faint);
}

.conn-jump {
  display: flex;
  align-items: center;
  padding: 4px 9px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--accent-line);
  font-size: 11px;
  color: var(--accent);
  white-space: nowrap;
  cursor: pointer;
  background: transparent;
  transition: background var(--dur-fast) var(--ease);
}

.conn-jump:hover {
  background: var(--accent-soft);
}

.conn-list {
  min-width: 260px;
  max-width: 380px;
  padding: 6px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hairline);
  background: var(--surface);
  box-shadow: var(--shadow-float);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.conn-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 11px;
}

.conn-row:hover {
  background: var(--tint-4);
}

.conn-label {
  color: var(--text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conn-meta {
  color: var(--text-faint);
  text-align: right;
}

.conn-tool {
  grid-column: 1 / -1;
  color: var(--text-dim);
  font-size: 10.5px;
}

.conn-more {
  padding: 6px 8px;
  border-top: 1px solid var(--hairline);
  color: var(--text-faint);
  font-size: 10.5px;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
