<script setup lang="ts">
import { mcpUi } from "../mcp-host";
</script>

<template>
  <div v-if="mcpUi.clients > 0" class="conn-status glass" role="status">
    <span class="dot" :class="{ busy: mcpUi.busy }" />
    <span class="text">
      {{ mcpUi.busy ? "agent 正在修改…" : `已连接 ${mcpUi.clients} 个 agent` }}
    </span>
    <span class="hint">可写</span>
  </div>
</template>

<style scoped>
.conn-status {
  position: absolute;
  top: 64px;
  left: 50%;
  translate: -50% 0;
  z-index: 9;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--hairline);
  font-size: 11px;
  color: var(--text-dim);
  pointer-events: none;
  white-space: nowrap;
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

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
