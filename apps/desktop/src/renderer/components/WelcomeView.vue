<script setup lang="ts">
/**
 * 欢迎页：状态 + 已检测到的客户端（可一键接入）+ 新建/打开/最近文件。
 * 完整清单与手动片段在配置面板里（ADR-0036）。
 */
import { computed, onMounted, ref, watch } from "vue";
import { newDocument, openDocument, openDocumentPath } from "../file-session";
import { MCP_TOOL_COUNT, mcpUi } from "../mcp-host";
import { mcpSetup } from "../mcp-setup";
import { MCP_CLIENT_LABELS, mcpClients, mcpClientsUi } from "../mcp-clients";
import { t } from "../i18n";
import { statusLine, welcomeMcpState } from "../mcp-welcome";
import { openExample } from "../examples";
import PromptList from "./PromptList.vue";
import type { McpClientId } from "../../shared/mcp-clients";

const emit = defineEmits<{ "open-mcp-setup": [] }>();

const recent = ref<{ path: string; name: string }[]>([]);
const message = ref("");
const info = mcpSetup.info;
const snapshot = computed(() => mcpClientsUi.snapshot);

const state = computed(() => welcomeMcpState(info.value, mcpUi.clients));
const statusText = computed(() => (mcpUi.busy ? t("welcome.busy") : statusLine(mcpUi)));
const detected = computed(() => (snapshot.value?.clients ?? []).filter((client) => client.detected));
const driftText = computed(() =>
  mcpUi.driftFrom ? t("welcome.drift", { from: mcpUi.driftFrom, to: mcpUi.port }) : "",
);

async function refreshRecent(): Promise<void> {
  recent.value = (await window.sqraft.recent.list()).slice(0, 4);
}

onMounted(() => {
  void refreshRecent();
  void mcpSetup.ensure().then((next) => {
    if (!next) message.value = t("welcome.readFailed");
  });
  void mcpClients.ensure().then((next) => {
    if (!next) message.value = t("welcome.readFailed");
  });
});

// 会话数变化时刷新四态（连接/断开都能反映到客户端行）
watch(
  () => mcpUi.clients.length,
  () => {
    void mcpClients.ensure(true);
  },
);

async function openRecent(path: string): Promise<void> {
  await openDocumentPath(path);
  await refreshRecent();
}

async function attach(id: McpClientId): Promise<void> {
  const result = await mcpClients.attach(id);
  if (!result?.ok) message.value = result?.issue?.message ?? mcpClientsUi.error;
  else message.value = "";
}

async function detach(id: McpClientId): Promise<void> {
  const result = await mcpClients.detach(id);
  if (!result?.ok) message.value = result?.issue?.message ?? mcpClientsUi.error;
  else message.value = "";
}
</script>

<template>
  <div class="welcome">
    <div class="card glass rise-in">
      <header class="brand">
        <span class="mark">S</span>
        <div class="titles">
          <h1>Sqraft</h1>
          <p>{{ t("welcome.tagline") }}</p>
        </div>
      </header>

      <section class="mcp">
        <div class="status" role="status">
          <span class="dot" :class="{ off: !mcpUi.listening, busy: mcpUi.busy }" />
          <span>{{ statusText }}</span>
        </div>
        <p class="capability">{{ t("welcome.capability", { count: MCP_TOOL_COUNT }) }}</p>

        <div v-if="detected.length > 0" class="client-list">
          <div class="client-title">{{ t("mcp.clients.detected") }}</div>
          <div v-for="client in detected" :key="client.id" class="client-row">
            <span class="client-name">{{ MCP_CLIENT_LABELS[client.id] }}</span>
            <span class="badge" :class="client.state">
              {{
                client.state === "connected"
                  ? t("mcp.clients.connected")
                  : client.state === "written"
                    ? t("mcp.clients.written")
                    : t("mcp.clients.absent")
              }}
            </span>
            <span class="spacer" />
            <button
              v-if="client.state === 'written' || client.state === 'connected'"
              class="pill ghost"
              :disabled="mcpClientsUi.busy === client.id"
              @click="detach(client.id)"
            >
              {{ t("mcp.clients.detach") }}
            </button>
            <button
              v-else-if="client.issue?.code !== 'CONFLICT'"
              class="pill"
              :disabled="mcpClientsUi.busy === client.id || !snapshot?.listening"
              @click="attach(client.id)"
            >
              {{ client.url ? t("mcp.clients.reattach") : t("mcp.clients.attach") }}
            </button>
            <button v-else class="pill ghost" @click="emit('open-mcp-setup')">
              {{ t("mcp.clients.issue") }}
            </button>
          </div>
        </div>
        <div v-else class="client-empty">
          <p>{{ t("mcp.clients.noneDetected") }}</p>
          <button class="pill ghost" @click="emit('open-mcp-setup')">
            {{ t("mcp.clients.all") }}
          </button>
        </div>

        <p v-if="driftText" class="warn">{{ driftText }}</p>

        <div class="mcp-actions">
          <span v-if="state === 'connected'" class="ready">{{ t("welcome.connected") }}</span>
          <button v-else-if="state === 'offline'" class="pill" @click="emit('open-mcp-setup')">
            {{ t("mcp.action.offline") }}
          </button>
          <span v-else class="ready">{{ t("welcome.attachHint") }}</span>
          <button class="link" type="button" @click="emit('open-mcp-setup')">{{ t("welcome.mcpSetup") }}</button>
        </div>

        <p v-if="message" class="message">{{ message }}</p>

        <PromptList v-if="state === 'connected'" compact />
      </section>

      <div class="divider" />

      <div class="start">
        <div class="actions">
          <button class="primary" type="button" @click="newDocument">{{ t("welcome.newDoc") }}</button>
          <button class="ghost" type="button" @click="openDocument">{{ t("welcome.open") }}</button>
        </div>

        <div class="examples">
          <div class="recent-title">{{ t("welcome.examples") }}</div>
          <div class="actions">
            <button class="pill ghost" type="button" @click="openExample('login')">{{ t("example.login") }}</button>
            <button class="pill ghost" type="button" @click="openExample('cards')">{{ t("example.cards") }}</button>
            <button class="pill ghost" type="button" @click="openExample('umbra')">{{ t("example.umbra") }}</button>
          </div>
        </div>

        <div v-if="recent.length > 0" class="recent">
          <div class="recent-title">{{ t("welcome.recent") }}</div>
          <ul>
            <li v-for="item in recent" :key="item.path">
              <button class="recent-item" :title="item.path" @click="openRecent(item.path)">
                <span class="name">{{ item.name }}</span>
                <span class="dir">{{ item.path.replace(/[^/\\]+$/, "") }}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
}

.card {
  width: min(620px, 100%);
  box-sizing: border-box;
  padding: 26px;
  border-radius: var(--radius-lg, 18px);
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.mark {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: var(--accent, #6366f1);
  color: #fff;
  font-size: 22px;
  font-weight: 600;
}

.titles h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--text);
}

.titles p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-dim);
}

.mcp {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
  flex: none;
}

.dot.off {
  background: var(--text-faint);
}

.dot.busy {
  background: var(--accent);
  animation: pulse 1s ease-in-out infinite;
}

.capability {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-dim);
}

.client-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.client-title {
  font-size: 11px;
  color: var(--text-faint);
  margin-bottom: 2px;
}

.client-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.client-name {
  font-size: 12.5px;
  color: var(--text);
  min-width: 88px;
}

.spacer {
  flex: 1;
}

.badge {
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--hairline);
  color: var(--text-faint);
}

.badge.connected {
  color: #15803d;
  border-color: #86efac;
  background: #f0fdf4;
}

.badge.written {
  color: var(--text);
  border-color: var(--hairline-strong);
}

.client-empty p {
  margin: 0 0 6px;
  font-size: 11.5px;
  color: var(--text-dim);
  line-height: 1.5;
}

.pill {
  border: 1px solid var(--hairline-strong);
  background: var(--glass);
  color: var(--text);
  border-radius: 7px;
  padding: 3px 9px;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  flex: none;
}

.pill:hover:not(:disabled) {
  background: var(--glass-strong);
}

.pill:disabled {
  opacity: 0.5;
  cursor: default;
}

.pill.ghost {
  border-color: var(--hairline);
  background: transparent;
  color: var(--text-dim);
}

.mcp-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.ready {
  font-size: 11.5px;
  color: var(--text-dim);
}

.link {
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 0;
}

.link:hover {
  color: var(--text-md, var(--text));
  text-decoration: underline;
}

.message {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-dim);
}

.warn {
  margin: 0;
  font-size: 11.5px;
  color: var(--warning, #a8641a);
}

.divider {
  height: 1px;
  background: var(--hairline);
}

.start {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.actions button {
  border-radius: 10px;
  padding: 9px 16px;
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background var(--dur-fast, 120ms) var(--ease, ease);
}

.primary {
  background: var(--accent, #6366f1);
  color: #fff;
}

.primary:hover {
  background: var(--accent-strong, #4f46e5);
}

.ghost {
  background: var(--glass);
  border: 1px solid var(--hairline-strong);
  color: var(--text);
}

.ghost:hover {
  background: var(--glass-strong);
}

.recent-title {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  margin-bottom: 6px;
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.recent-item {
  width: 100%;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
}

.recent-item:hover {
  background: var(--glass-strong, var(--tint-6));
}

.dir {
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 55%;
  direction: rtl;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
