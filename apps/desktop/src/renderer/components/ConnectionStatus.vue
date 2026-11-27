<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { agentReport, type AgentAction } from "../agent-report";
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
/** 变更清单 / 诊断：上次调用留下的，保留到下一次调用或撤销 */
const hasReport = computed(() => agentReport.changes.length > 0 || agentReport.diagnostics.length > 0);

/** 动作词与诊断文案都按当前语言取；`t` 读响应式的 locale，切换语言会自动重算 */
const actionLabels = computed<Record<AgentAction, string>>(() => ({
  create: t("conn.action.create"),
  update: t("conn.action.update"),
  delete: t("conn.action.delete"),
  move: t("conn.action.move"),
  instance: t("conn.action.instance"),
  doc: t("conn.action.doc"),
}));

const diagLabels = computed<Record<string, string>>(() => ({
  ZERO_SIZE: t("diag.ZERO_SIZE"),
  TEXT_NO_FILL: t("diag.TEXT_NO_FILL"),
  TEXT_OVERFLOW: t("diag.TEXT_OVERFLOW"),
  TOKEN_MISSING: t("diag.TOKEN_MISSING"),
  OUTSIDE_PARENT: t("diag.OUTSIDE_PARENT"),
}));

/** 清单条目：选中 + 定位 + 脉冲标记（与图层面板"定位"同一条路径） */
function locate(nodeId: string): void {
  open.value = false;
  hooks.focusNode(nodeId);
}

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
  // agent 断开后清单还在：胶囊不能跟着消失，否则上次改动就再也点不开了
  if (count.value === 0 && hasReport.value) return t("conn.lastChange");
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
  <div v-if="count > 0 || mcpUi.activity || hasReport" class="conn-wrap">
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

      <!-- 变更清单 + 诊断：两段并列，都是"事后追认"的信息，所以跟连接详情共用一个浮层。
           调用进行中先不显示——那会儿清单还是上一次的内容，标题写"本次改动"会误导。 -->
      <template v-if="hasReport && !mcpUi.activity?.running">
        <div v-if="agentReport.changes.length > 0" class="conn-section">
          <span>{{ t("conn.changesTitle", { count: agentReport.total }) }}</span>
          <span class="conn-section-hint">{{ t("conn.locate") }}</span>
        </div>
        <button
          v-for="change in agentReport.changes"
          :key="change.nodeId"
          type="button"
          class="conn-item"
          @click="locate(change.nodeId)"
        >
          <span class="conn-item-name">{{ change.nodeName }}</span>
          <span class="conn-item-action">{{ actionLabels[change.action] }}</span>
        </button>
        <div v-if="agentReport.total > agentReport.changes.length" class="conn-more">
          {{ t("conn.changesMore", { count: agentReport.total - agentReport.changes.length }) }}
        </div>

        <div v-if="agentReport.diagnostics.length > 0" class="conn-section">
          <span>{{ t("conn.diagnosticsTitle", { count: agentReport.diagnostics.length }) }}</span>
          <span class="conn-section-hint">{{ t("conn.locate") }}</span>
        </div>
        <button
          v-for="(item, index) in agentReport.diagnostics"
          :key="`${item.nodeId}-${index}`"
          type="button"
          class="conn-item"
          @click="locate(item.nodeId)"
        >
          <span class="conn-item-name">{{ item.nodeName }}</span>
          <span class="conn-item-action">{{ diagLabels[item.code] ?? item.code }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.conn-wrap {
  position: absolute;
  /* 顶部模块占掉 34px：保持胶囊在窗口顶部下 64px 的位置 */
  top: 30px;
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

/* 变更清单与诊断的分段标题（两段都可点条目定位） */
.conn-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  padding: 5px 8px 2px;
  border-top: 1px solid var(--hairline);
  color: var(--text-faint);
  font-size: 10px;
}

.conn-section:first-child {
  margin-top: 0;
  border-top: none;
}

.conn-section-hint {
  opacity: 0.7;
}

.conn-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 10px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font: inherit;
  font-size: 11px;
  text-align: left;
  color: var(--text-dim);
  cursor: pointer;
}

.conn-item:hover {
  background: var(--tint-4);
}

.conn-item-name {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conn-item-action {
  color: var(--text-faint);
  text-align: right;
  white-space: nowrap;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
