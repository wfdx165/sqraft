<script setup lang="ts">
/**
 * 配置面板：端点 / 端口 / 六个客户端（四态 + 显式操作）/ 手动片段。
 * 所有客户端操作只传 id，路径与命令由主进程解析（ADR-0036）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { mcpSetup } from "../mcp-setup";
import { MCP_CLIENT_LABELS, MCP_CLIENT_ORDER, mcpClients, mcpClientsUi } from "../mcp-clients";
import { mcpUi } from "../mcp-host";
import { t } from "../i18n";
import PromptList from "./PromptList.vue";
import type { McpClientState } from "../../shared/ipc";
import type { McpClientId } from "../../shared/mcp-clients";

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });
const emit = defineEmits<{ close: [] }>();

const info = mcpSetup.info;
const snapshot = computed(() => mcpClientsUi.snapshot);
const message = ref("");
const saving = ref(false);
const portInput = ref("");
const manualOpen = ref(false);
const copied = ref<string | null>(null);
const reloading = ref(false);
let copiedTimer = 0;

const statusText = computed(() => {
  if (!info.value) return t("mcp.status.loading");
  if (info.value.listening) return t("mcp.panelListening", { url: info.value.url });
  return info.value.error
    ? t("mcp.status.stoppedWithError", { error: info.value.error })
    : t("mcp.status.stopped");
});

const driftText = computed(() => {
  if (!info.value?.driftFrom) return "";
  return t("mcp.drift", { from: info.value.driftFrom, to: info.value.port });
});

const clients = computed<McpClientState[]>(() => {
  const list = snapshot.value?.clients ?? [];
  return [...list].sort((a, b) => MCP_CLIENT_ORDER.indexOf(a.id) - MCP_CLIENT_ORDER.indexOf(b.id));
});

const portDirty = computed(() => {
  if (!info.value) return false;
  const current = info.value.explicitPort;
  const raw = portInput.value.trim();
  if (raw === "") return current !== null;
  return Number(raw) !== current;
});

const snippets = computed<Record<string, string>>(() => ({
  claude: info.value?.commandLine ?? "",
  codex: info.value?.codexToml ?? "",
  opencode: info.value?.opencodeJson ?? "",
  cursor: info.value?.cursorJson ?? "",
  vscode: info.value?.vscodeJson ?? "",
  zed: info.value?.zedJson ?? "",
  generic: info.value?.url ?? "",
}));

const snippetDefs = computed(() => [
  { id: "claude", label: "Claude Code（~/.claude.json）", text: snippets.value.claude },
  { id: "codex", label: "Codex（~/.codex/config.toml）", text: snippets.value.codex },
  { id: "opencode", label: "OpenCode（~/.config/opencode/opencode.json）", text: snippets.value.opencode },
  { id: "cursor", label: "Cursor（~/.cursor/mcp.json）", text: snippets.value.cursor },
  { id: "vscode", label: "VS Code（~/.copilot/mcp-config.json）", text: snippets.value.vscode },
  { id: "zed", label: "Zed（~/.config/zed/settings.json）", text: snippets.value.zed },
  { id: "generic", label: t("mcp.genericUrl"), text: snippets.value.generic },
]);

function stateLabel(state: McpClientState["state"]): string {
  switch (state) {
    case "connected":
      return t("mcp.clients.connected");
    case "written":
      return t("mcp.clients.written");
    case "absent":
      return t("mcp.clients.absent");
    case "undetected":
      return t("mcp.clients.undetected");
  }
}

function canAttach(client: McpClientState): boolean {
  return (
    client.detected &&
    client.state === "absent" &&
    client.issue?.code !== "CONFLICT" &&
    snapshot.value?.listening === true
  );
}

function clientSnippet(id: McpClientId): string {
  switch (id) {
    case "claude-code":
      return snippets.value.claude ?? "";
    case "codex":
      return snippets.value.codex ?? "";
    case "opencode":
      return snippets.value.opencode ?? "";
    case "cursor":
      return snippets.value.cursor ?? "";
    case "vscode":
      return snippets.value.vscode ?? "";
    case "zed":
      return snippets.value.zed ?? "";
  }
}

async function load(): Promise<void> {
  const [next] = await Promise.all([mcpSetup.ensure(true), mcpClients.ensure(true)]);
  message.value = next ? "" : t("mcp.readFailed");
  portInput.value = next?.explicitPort === null || next?.explicitPort === undefined ? "" : String(next.explicitPort);
}

async function redetect(): Promise<void> {
  reloading.value = true;
  try {
    await load();
  } finally {
    reloading.value = false;
  }
}

async function applyPort(): Promise<void> {
  const raw = portInput.value.trim();
  const port = raw === "" ? null : Number(raw);
  if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    message.value = t("mcp.portRange");
    return;
  }
  saving.value = true;
  message.value = "";
  try {
    const next = await mcpSetup.savePort(port);
    portInput.value = next.explicitPort === null ? "" : String(next.explicitPort);
    message.value = next.listening ? t("mcp.applied") : (next.error ?? t("mcp.savedNotStarted"));
    await mcpClients.ensure(true);
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}

async function attach(id: McpClientId): Promise<void> {
  const result = await mcpClients.attach(id);
  message.value = result?.ok ? "" : (result?.issue?.message ?? mcpClientsUi.error);
}

async function detach(id: McpClientId): Promise<void> {
  const result = await mcpClients.detach(id);
  message.value = result?.ok ? "" : (result?.issue?.message ?? mcpClientsUi.error);
}

async function replace(id: McpClientId): Promise<void> {
  if (!window.confirm(t("mcp.clients.replaceConfirm"))) return;
  const result = await mcpClients.replace(id);
  message.value = result?.ok ? t("mcp.clients.replaceDone") : (result?.issue?.message ?? mcpClientsUi.error);
}

function copy(key: string, text: string | undefined): void {
  if (!text) return;
  window.sqraft.app.copyText(text);
  copied.value = key;
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    if (copied.value === key) copied.value = null;
  }, 1400);
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

onMounted(() => {
  void load();
  if (!props.embedded) window.addEventListener("keydown", onKey);
});

// 客户端重启后回来，连接状态要跟着变
watch(
  () => mcpUi.clients.length,
  () => {
    void mcpClients.ensure(true);
  },
);
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.clearTimeout(copiedTimer);
});
</script>

<template>
  <div :class="embedded ? 'embedded' : 'overlay'" @click.self="$emit('close')">
    <div :class="embedded ? 'embedded-panel' : 'panel glass'">
      <header v-if="!embedded">
        <h2>{{ t("mcp.title") }}</h2>
        <button class="icon" :title="t('common.close')" @click="$emit('close')">✕</button>
      </header>

      <p class="lede">
        {{ t("mcp.lede") }}
      </p>

      <section class="endpoint">
        <div class="label"><span>{{ t("mcp.endpoint") }}</span></div>
        <pre>{{ info?.url ?? "—" }}</pre>
        <p class="hint">{{ t("mcp.localOnly") }}</p>
        <p class="status">{{ statusText }}</p>
        <p v-if="driftText" class="warn">{{ driftText }}</p>
      </section>

      <section class="port">
        <div class="label"><span>{{ t("mcp.port") }}</span></div>
        <div class="port-row">
          <input
            v-model="portInput"
            inputmode="numeric"
            :placeholder="t('mcp.portPlaceholder')"
            spellcheck="false"
          />
          <button class="primary" :disabled="saving || !portDirty" @click="applyPort">
            {{ saving ? t("mcp.applying") : t("mcp.apply") }}
          </button>
        </div>
        <p class="hint">
          {{ t("mcp.portHint") }}
        </p>
      </section>

      <section class="clients">
        <div class="label">
          <span>{{ t("mcp.clients.title") }}</span>
          <span class="count">{{ snapshot?.listening ? "" : t("mcp.clients.serverDown") }}</span>
          <button class="redetect" :disabled="reloading" @click="redetect">
            {{ reloading ? "…" : "↻" }} {{ t("mcp.clients.redetect") }}
          </button>
        </div>

        <p v-if="!snapshot" class="hint">{{ t("mcp.status.loading") }}</p>

        <div v-for="client in clients" :key="client.id" class="client">
          <div class="client-head">
            <span class="client-name">{{ MCP_CLIENT_LABELS[client.id] }}</span>
            <span class="badge" :class="client.state">{{ stateLabel(client.state) }}</span>
            <span v-if="client.sessions > 0" class="sessions">
              {{ t("mcp.clients.sessions", { count: client.sessions }) }}
            </span>
            <span class="spacer" />
            <button
              v-if="canAttach(client)"
              class="action"
              :disabled="mcpClientsUi.busy === client.id"
              @click="attach(client.id)"
            >
              {{ client.url ? t("mcp.clients.reattach") : t("mcp.clients.attach") }}
            </button>
            <button
              v-if="client.issue?.code === 'CONFLICT'"
              class="action"
              :disabled="mcpClientsUi.busy === client.id"
              @click="replace(client.id)"
            >
              {{ t("mcp.clients.replace") }}
            </button>
            <button
              v-if="client.state === 'written' || client.state === 'connected'"
              class="action ghost"
              :disabled="mcpClientsUi.busy === client.id"
              @click="detach(client.id)"
            >
              {{ t("mcp.clients.detach") }}
            </button>
            <button class="action ghost" @click="copy(`client-${client.id}`, clientSnippet(client.id))">
              {{ copied === `client-${client.id}` ? t("common.copied") : t("mcp.clients.copy") }}
            </button>
          </div>

          <p v-if="client.restartHint" class="restart">
            {{ t("mcp.clients.restart", { hint: t(client.restartHint) }) }}
          </p>
          <div v-if="client.issue" class="issue">
            <p>{{ client.issue.message }}</p>
            <pre v-if="client.issue.existing">{{ client.issue.existing }}</pre>
            <p v-else-if="client.issue.detail" class="detail">{{ client.issue.detail }}</p>
          </div>
        </div>

        <div class="client generic">
          <div class="client-head">
            <span class="client-name">{{ t("mcp.clientGeneric") }}</span>
            <span class="spacer" />
            <button class="action ghost" @click="copy('generic', snippets.generic)">
              {{ copied === "generic" ? t("common.copied") : t("mcp.clients.copy") }}
            </button>
          </div>
        </div>
      </section>

      <section class="prompts">
        <div class="label"><span>{{ t("onboarding.title") }}</span></div>
        <PromptList />
      </section>

      <section class="manual-section">
        <button class="manual-toggle" @click="manualOpen = !manualOpen">
          {{ manualOpen ? "▾" : "▸" }} {{ t("mcp.clients.manual") }}
        </button>
        <div v-if="manualOpen" class="manual">
          <div v-for="def in snippetDefs" :key="def.id" class="snippet">
            <div class="label">
              <span>{{ def.label }}</span>
              <button class="copy" :disabled="!def.text" @click="copy(def.id, def.text)">
                {{ copied === def.id ? t("common.copied") : t("common.copy") }}
              </button>
            </div>
            <pre>{{ def.text || "—" }}</pre>
          </div>
        </div>
      </section>

      <p v-if="message || mcpClientsUi.error" class="message">{{ message || mcpClientsUi.error }}</p>
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

/* 嵌进设置外壳时去掉自己的遮罩、内边距与滚动条，由外壳统一负责 */
.embedded {
  display: block;
}

.embedded-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel {
  width: min(660px, calc(100vw - 48px));
  max-height: calc(100vh - 80px);
  overflow: auto;
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
  background: var(--glass-strong);
  color: var(--text);
}

.lede {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
}

.label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: var(--text-faint);
  margin-bottom: 6px;
}

.count {
  font-weight: 400;
}

.redetect {
  margin-left: auto;
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  padding: 2px 8px;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.redetect:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--hairline-strong);
}

.redetect:disabled {
  opacity: 0.5;
  cursor: default;
}

.clients {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.client {
  padding: 7px 0;
  border-top: 1px solid var(--hairline);
}

.client-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
}

.client-name {
  font-size: 12.5px;
  color: var(--text);
  min-width: 92px;
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

.badge.undetected {
  opacity: 0.6;
}

.sessions {
  font-size: 10.5px;
  color: var(--text-faint);
}

.action {
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

.action:hover:not(:disabled) {
  background: var(--glass-strong);
}

.action:disabled {
  opacity: 0.5;
  cursor: default;
}

.action.ghost {
  border-color: var(--hairline);
  background: transparent;
  color: var(--text-dim);
}

.restart {
  margin: 4px 0 0 100px;
  font-size: 11px;
  color: var(--text-faint);
}

.issue {
  margin: 4px 0 0 100px;
  font-size: 11.5px;
  color: var(--warning, #a8641a);
}

.issue p {
  margin: 0;
}

.issue .detail {
  margin-top: 2px;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}

.issue pre {
  margin-top: 4px;
  max-height: 120px;
  overflow: auto;
}

.generic {
  padding-top: 10px;
}

.manual-toggle {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 11.5px;
  cursor: pointer;
  padding: 0;
}

.manual-toggle:hover {
  color: var(--text);
}

.manual {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 10px;
}

.snippet .label {
  margin-bottom: 4px;
}

.copy {
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

.copy:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--hairline-strong);
}

.copy:disabled {
  opacity: 0.5;
  cursor: default;
}

pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--tint-4);
  border: 1px solid var(--hairline);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
}

.hint {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--text-dim);
  line-height: 1.5;
}

.status {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--text-dim);
}

.warn {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--warning, #a8641a);
}

.port-row {
  display: flex;
  gap: 8px;
}

.port-row input {
  flex: 1;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  padding: 7px 10px;
  background: var(--tint-4);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  outline: none;
}

.port-row input:focus {
  border-color: var(--hairline-strong);
}

.primary {
  flex: none;
  border: none;
  border-radius: 9px;
  padding: 8px 14px;
  background: var(--accent);
  color: #fff;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.message {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-dim);
}
</style>
