<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { mcpUi, refreshMcpStatus } from "../mcp-host";

const open = ref(false);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

const count = computed(() => mcpUi.clients.length);

/** 连接时长：只在浮层打开时刷新，避免常驻定时器 */
function durationOf(connectedAt: number): string {
  const seconds = Math.max(0, Math.round((now.value - connectedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.round(minutes / 60)} 小时`;
}

function toolLabel(client: { lastTool?: string; lastToolAt?: number }): string {
  if (!client.lastTool) return "尚未调用工具";
  const seconds = Math.max(0, Math.round((now.value - (client.lastToolAt ?? now.value)) / 1000));
  return `${client.lastTool} · ${seconds < 60 ? `${seconds} 秒前` : `${Math.round(seconds / 60)} 分钟前`}`;
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
  <div v-if="count > 0" class="conn-wrap">
    <button class="conn-status glass" :class="{ open }" role="status" @click="toggle">
      <span class="dot" :class="{ busy: mcpUi.busy }" />
      <span class="text">{{ mcpUi.busy ? "agent 正在修改…" : `已连接 ${count} 个 agent` }}</span>
      <span class="hint">{{ open ? "收起" : "详情" }}</span>
    </button>

    <div v-if="open" class="conn-list glass">
      <div v-for="client in mcpUi.clients" :key="client.id" class="conn-row">
        <span class="conn-label">{{ client.label }}</span>
        <span class="conn-meta">已连接 {{ durationOf(client.connectedAt) }}</span>
        <span class="conn-tool">{{ toolLabel(client) }}</span>
      </div>
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

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
