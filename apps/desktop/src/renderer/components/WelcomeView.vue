<script setup lang="ts">
/**
 * 欢迎页：以 MCP 接入为主位（ADR-0021）。
 * 上半回答"服务在不在、能干什么、怎么接上"，下半才是新建/打开与最近文件。
 */
import { computed, onMounted, ref } from "vue";
import { newDocument, openDocument, openDocumentPath } from "../file-session";
import { MCP_TOOL_COUNT, mcpUi } from "../mcp-host";
import { mcpSetup } from "../mcp-setup";
import {
  MCP_CLIENTS,
  actionText,
  clientSnippet,
  statusLine,
  welcomeMcpState,
  type McpClient,
} from "../mcp-welcome";

const emit = defineEmits<{ "open-mcp-setup": [] }>();

const recent = ref<{ path: string; name: string }[]>([]);
const info = mcpSetup.info;
const copied = ref(false);
const message = ref("");
const client = ref<McpClient>("claude");

const state = computed(() => welcomeMcpState(info.value, mcpUi.clients));
const statusText = computed(() => (mcpUi.busy ? "agent 正在修改文档…" : statusLine(mcpUi)));
const snippet = computed(() => clientSnippet(info.value, client.value));
const driftText = computed(() =>
  mcpUi.driftFrom ? `端口 ${mcpUi.driftFrom} 被占用，已改用 ${mcpUi.port}；请更新已配置的客户端。` : "",
);

async function refreshRecent(): Promise<void> {
  recent.value = (await window.sqraft.recent.list()).slice(0, 4);
}

onMounted(() => {
  void refreshRecent();
  // 与配置面板共用同一份配置：面板里改完端口会直接反映到这里
  void mcpSetup.ensure().then((next) => {
    if (!next) message.value = "读取接入配置失败，可以打开端口设置重试。";
  });
});

async function openRecent(path: string): Promise<void> {
  await openDocumentPath(path);
  // 失效条目会被主进程剔除，回来后重新取一次
  await refreshRecent();
}

function copySnippet(): void {
  if (!snippet.value) return;
  window.sqraft.app.copyText(snippet.value);
  copied.value = true;
  window.setTimeout(() => {
    if (copied.value) copied.value = false;
  }, 1400);
}

/** 三态主按钮：服务没起来去查端口，没人连就复制片段，已连接则没有动作 */
function runPrimary(): void {
  if (state.value === "offline") emit("open-mcp-setup");
  else if (state.value === "idle") copySnippet();
}

/** 切换客户端预设：外壳不同，指向同一个端点 */
function switchClient(next: McpClient): void {
  if (client.value === next) return;
  client.value = next;
  copied.value = false;
}
</script>

<template>
  <div class="welcome">
    <div class="card glass rise-in">
      <header class="brand">
        <span class="mark">S</span>
        <div class="titles">
          <h1>Sqraft</h1>
          <p>为 AI 原生而设计的 UI/UX 工具</p>
        </div>
      </header>

      <section class="mcp">
        <div class="status" role="status">
          <span class="dot" :class="{ off: !mcpUi.listening, busy: mcpUi.busy }" />
          <span>{{ statusText }}</span>
        </div>
        <p class="capability">{{ MCP_TOOL_COUNT }} 个工具 · agent 可读写当前画布</p>

        <div class="clients" role="tablist" aria-label="客户端">
          <button
            v-for="item in MCP_CLIENTS"
            :key="item.id"
            class="client"
            :class="{ on: client === item.id }"
            role="tab"
            :aria-selected="client === item.id"
            type="button"
            @click="switchClient(item.id)"
          >
            {{ item.label }}
          </button>
        </div>

        <div class="command">
          <code :title="snippet">{{ snippet }}</code>
          <button class="copy" type="button" :disabled="!snippet" @click="copySnippet">
            {{ copied ? "已复制" : "复制" }}
          </button>
        </div>

        <p v-if="driftText" class="warn">{{ driftText }}</p>

        <div class="mcp-actions">
          <button v-if="state !== 'connected'" class="install" type="button" @click="runPrimary">
            {{ actionText(state) }}
          </button>
          <span v-else class="ready">agent 已接入，可以直接下指令</span>
          <button class="link" type="button" @click="emit('open-mcp-setup')">端口设置 / 全部客户端</button>
        </div>

        <p v-if="message" class="message">{{ message }}</p>
      </section>

      <div class="divider" />

      <div class="start">
        <div class="actions">
          <button class="primary" type="button" @click="newDocument">新建文档</button>
          <button class="ghost" type="button" @click="openDocument">打开…</button>
        </div>

        <div v-if="recent.length > 0" class="recent">
          <div class="recent-title">最近打开</div>
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

.clients {
  display: flex;
  gap: 2px;
  margin-bottom: -4px;
}

.client {
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-family: inherit;
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 6px;
  cursor: pointer;
  transition: color var(--dur-fast, 120ms) var(--ease, ease);
}

.client:hover {
  color: var(--text);
}

.client.on {
  color: var(--text);
  background: var(--glass-strong);
}

.command {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 10px;
  border-radius: var(--radius-sm, 8px);
  background: var(--tint-4);
  border: 1px solid var(--hairline);
}

.command code {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* 右侧渐隐：提示还有内容，但不让它撑破卡片 */
  mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent);
}

.copy {
  flex: none;
  border: 1px solid var(--hairline-strong);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  padding: 3px 9px;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.copy:hover {
  color: var(--text);
}

.copy:disabled {
  opacity: 0.5;
  cursor: default;
}

.mcp-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.install {
  flex: none;
  border: 1px solid var(--hairline-strong);
  background: var(--glass);
  color: var(--text);
  border-radius: 9px;
  padding: 6px 12px;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background var(--dur-fast, 120ms) var(--ease, ease);
}

.install:hover:not(:disabled) {
  background: var(--glass-strong);
}

.install:disabled {
  opacity: 0.6;
  cursor: default;
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
