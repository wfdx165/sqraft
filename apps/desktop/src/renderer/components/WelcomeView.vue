<script setup lang="ts">
/**
 * 欢迎页（Home 标签）：左边是文档入口（品牌 / 新建打开 / 最近文件 / 示例），
 * 右边是 agent 接入（MCP 状态 / 地址 / 客户端 / 提示词）。
 *
 * 最近文件带封面：保存或打开时由渲染层画一张当前活动页，主进程按「路径 + mtime」
 * 缓存（见 `main/thumbnails.ts`）；旧文件第一次打开后会补一张，外部改过的文件显示占位。
 */
import { computed, onMounted, ref, watch } from "vue";
import { newDocument, openDocument, openDocumentPath } from "../file-session";
import { MCP_TOOL_COUNT, mcpUi } from "../mcp-host";
import { mcpSetup } from "../mcp-setup";
import { MCP_CLIENT_LABELS, mcpClients, mcpClientsUi } from "../mcp-clients";
import { t } from "../i18n";
import { statusLine, welcomeMcpState } from "../mcp-welcome";
import { openExample } from "../examples";
import { keyLabel } from "../shortcuts";
import { relativeLabel, timeBucket } from "../relative-time";
import { sortRecent } from "../recent-order";
import PromptList from "./PromptList.vue";
import type { McpClientId } from "../../shared/mcp-clients";
import type { MessageKey } from "../../shared/i18n";
import type { RecentEntry } from "../../shared/ipc";

const emit = defineEmits<{ "open-mcp-setup": [] }>();

/** 最近文件一次展示 6 个（3×2）；存储上限是 8，其余走「文件 → 打开最近」。 */
const RECENT_LIMIT = 6;

const recent = ref<RecentEntry[]>([]);
const message = ref("");
const copiedEndpoint = ref(false);
/** 「清空」的两步确认：第一次点亮，3 秒内再点一次才真的清 */
const clearArmed = ref(false);
let clearTimer: number | undefined;
const info = mcpSetup.info;
const snapshot = computed(() => mcpClientsUi.snapshot);

const state = computed(() => welcomeMcpState(info.value, mcpUi.clients));
const statusText = computed(() => (mcpUi.busy ? t("welcome.busy") : statusLine(mcpUi)));
const detected = computed(() => (snapshot.value?.clients ?? []).filter((client) => client.detected));
const driftText = computed(() =>
  mcpUi.driftFrom ? t("welcome.drift", { from: mcpUi.driftFrom, to: mcpUi.port }) : "",
);
const endpoint = computed(() => info.value?.url ?? "");

const EXAMPLES: readonly { id: "login" | "cards" | "umbra"; title: MessageKey; desc: MessageKey }[] = [
  { id: "login", title: "example.login", desc: "example.login.desc" },
  { id: "cards", title: "example.cards", desc: "example.cards.desc" },
  { id: "umbra", title: "example.umbra", desc: "example.umbra.desc" },
];

async function refreshRecent(): Promise<void> {
  // 主进程按「最近打开」存，欢迎页按「最近修改」展示：打开不重排，保存后才前移
  recent.value = sortRecent(await window.sqraft.recent.list()).slice(0, RECENT_LIMIT);
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

function metaOf(item: RecentEntry): string {
  if (item.mtimeMs === null) return t("welcome.recentMissing");
  return relativeLabel(timeBucket(item.mtimeMs));
}

/** 没有封面时用文件名首字撑住卡片，比一个灰色空框更像"这里有一份稿子"。 */
function initialOf(item: RecentEntry): string {
  return item.name.replace(/\.[^.]+$/, "").slice(0, 1).toUpperCase() || "S";
}

async function openRecent(item: RecentEntry): Promise<void> {
  // 已知不存在的文件不再走打开链路：`openDocumentPath` 会弹系统错误框
  if (item.mtimeMs === null) {
    message.value = t("welcome.recentMissing");
    return;
  }
  await openDocumentPath(item.path);
  await refreshRecent();
}

/** 两步式清空：列表本身可重建，但误点一次就清掉还是太突然。 */
async function clearRecent(): Promise<void> {
  if (!clearArmed.value) {
    clearArmed.value = true;
    window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      clearArmed.value = false;
    }, 3000);
    return;
  }
  window.clearTimeout(clearTimer);
  clearArmed.value = false;
  await window.sqraft.recent.clear();
  await refreshRecent();
}

function copyEndpoint(): void {
  if (!endpoint.value || !mcpUi.listening) return;
  window.sqraft.app.copyText(endpoint.value);
  copiedEndpoint.value = true;
  window.setTimeout(() => {
    copiedEndpoint.value = false;
  }, 1400);
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
      <section class="docs">
        <header class="brand">
          <span class="mark">S</span>
          <div class="titles">
            <h1>Sqraft</h1>
            <p>{{ t("welcome.tagline") }}</p>
          </div>
        </header>

        <div class="actions">
          <button class="primary" type="button" @click="newDocument">
            <span>{{ t("welcome.newDoc") }}</span>
            <kbd>{{ keyLabel("file.new") }}</kbd>
          </button>
          <button class="ghost" type="button" @click="openDocument">
            <span>{{ t("welcome.open") }}</span>
            <kbd>{{ keyLabel("file.open") }}</kbd>
          </button>
        </div>

        <section class="recent">
          <div class="recent-head">
            <div class="section-title">{{ t("welcome.recent") }}</div>
            <button
              v-if="recent.length > 0"
              class="clear"
              :class="{ armed: clearArmed }"
              type="button"
              @click="clearRecent"
            >
              {{ clearArmed ? t("welcome.recentClearConfirm") : t("welcome.recentClear") }}
            </button>
          </div>
          <div v-if="recent.length > 0" class="recent-grid">
            <button
              v-for="item in recent"
              :key="item.path"
              class="recent-card"
              type="button"
              :title="item.path"
              :class="{ gone: item.mtimeMs === null }"
              @click="openRecent(item)"
            >
              <span class="thumb">
                <img v-if="item.thumbnail && item.mtimeMs !== null" :src="item.thumbnail" alt="" />
                <span v-else class="thumb-empty">{{ initialOf(item) }}</span>
              </span>
              <span class="recent-name">{{ item.name }}</span>
              <span class="recent-meta">{{ metaOf(item) }}</span>
            </button>
          </div>
          <div v-else class="recent-empty">{{ t("welcome.recentEmpty") }}</div>
        </section>

        <section class="examples">
          <div class="section-title">{{ t("welcome.examples") }}</div>
          <div class="example-grid">
            <button
              v-for="example in EXAMPLES"
              :key="example.id"
              class="example-card"
              type="button"
              @click="openExample(example.id)"
            >
              <span class="example-title">{{ t(example.title) }}</span>
              <span class="example-desc">{{ t(example.desc) }}</span>
            </button>
          </div>
        </section>
      </section>

      <aside class="agent">
        <div class="status" role="status">
          <span class="dot" :class="{ off: !mcpUi.listening, busy: mcpUi.busy }" />
          <span class="status-text">{{ statusText }}</span>
        </div>
        <p class="capability">{{ t("welcome.capability", { count: MCP_TOOL_COUNT }) }}</p>

        <div class="endpoint" :class="{ off: !mcpUi.listening }">
          <code>{{ endpoint }}</code>
          <button class="pill ghost" type="button" :disabled="!mcpUi.listening" @click="copyEndpoint">
            {{ copiedEndpoint ? t("common.copied") : t("common.copy") }}
          </button>
        </div>

        <section class="clients">
          <div class="section-title">{{ t("mcp.clients.detected") }}</div>
          <template v-if="detected.length > 0">
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
          </template>
          <div v-else class="client-empty">
            <p>{{ t("mcp.clients.noneDetected") }}</p>
            <button class="pill ghost" type="button" @click="emit('open-mcp-setup')">
              {{ t("mcp.clients.all") }}
            </button>
          </div>
        </section>

        <section class="prompts">
          <div class="section-title">
            {{ state === "connected" ? t("welcome.prompts.active") : t("welcome.prompts.idle") }}
          </div>
          <PromptList compact />
        </section>

        <p v-if="driftText" class="warn">{{ driftText }}</p>
        <p v-if="message" class="message">{{ message }}</p>

        <button class="link" type="button" @click="emit('open-mcp-setup')">{{ t("welcome.mcpSetup") }}</button>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  height: 100%;
  display: flex;
  overflow: auto;
  padding: 28px 24px;
}

.card {
  width: min(1120px, 100%);
  margin: auto;
  box-sizing: border-box;
  padding: 30px 32px;
  display: grid;
  grid-template-columns: minmax(0, 1.62fr) minmax(280px, 1fr);
  gap: 30px;
}

/* 左栏：文档入口 */
.docs {
  min-width: 0;
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
  flex: none;
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

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.actions button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border-radius: 10px;
  padding: 9px 14px;
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

kbd {
  font-family: var(--mono);
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 5px;
  border: 1px solid currentColor;
  opacity: 0.55;
}

.section-title {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  margin-bottom: 7px;
}

.recent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 7px;
}

.recent-head .section-title {
  margin-bottom: 0;
}

.clear {
  border: none;
  background: transparent;
  padding: 0;
  font-family: inherit;
  font-size: 11px;
  color: var(--text-faint);
  cursor: pointer;
}

.clear:hover {
  color: var(--text);
}

.clear.armed {
  color: var(--danger, #d64545);
}

.recent-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.recent-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.recent-card.gone {
  color: var(--text-faint);
}

.thumb {
  display: grid;
  place-items: center;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--hairline);
  background: #eceef3;
  transition: border-color var(--dur-fast, 120ms) var(--ease, ease);
}

.recent-card:hover .thumb {
  border-color: var(--hairline-strong);
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.recent-card.gone .thumb {
  opacity: 0.45;
}

.thumb-empty {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-faint);
}

.recent-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-meta {
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-empty {
  border: 1px solid var(--hairline);
  border-radius: 10px;
  background: var(--tint-3);
  padding: 30px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-faint);
}

.example-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.example-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--hairline);
  border-radius: 10px;
  background: var(--tint-3);
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast, 120ms) var(--ease, ease);
}

.example-card:hover {
  background: var(--tint-5);
}

.example-title {
  font-size: 12.5px;
}

.example-desc {
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-faint);
}

/* 右栏：agent 接入 */
.agent {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--hairline);
  padding-left: 28px;
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
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--text-dim);
}

.endpoint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.endpoint code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-dim);
  background: var(--tint-4);
  border: 1px solid var(--hairline);
  border-radius: 8px;
  padding: 5px 8px;
}

.endpoint.off code {
  opacity: 0.55;
}

.clients {
  margin-top: 16px;
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
  min-width: 84px;
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
  flex: none;
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

.prompts {
  margin-top: 16px;
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

.warn {
  margin: 10px 0 0;
  font-size: 11.5px;
  color: var(--warning, #a8641a);
}

.message {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--text-dim);
}

.link {
  margin-top: auto;
  padding: 14px 0 0;
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.link:hover {
  color: var(--text-md, var(--text));
  text-decoration: underline;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

@media (max-width: 1100px) {
  .welcome {
    padding: 20px 18px;
  }

  .card {
    padding: 24px;
    gap: 22px;
  }

  .agent {
    padding-left: 22px;
  }
}
</style>
