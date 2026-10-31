<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { mcpSetup } from "../mcp-setup";

const emit = defineEmits<{ close: [] }>();

const info = mcpSetup.info;
const message = ref("");
const saving = ref(false);
const portInput = ref("");
const copied = ref<"claude" | "opencode" | "cursor" | "generic" | null>(null);

const statusText = computed(() => {
  if (!info.value) return "读取配置中…";
  if (info.value.listening) return `监听中 · ${info.value.url}`;
  return info.value.error ? `未启动 · ${info.value.error}` : "未启动";
});

const driftText = computed(() => {
  if (!info.value?.driftFrom) return "";
  return `端口 ${info.value.driftFrom} 被占用，已改用 ${info.value.port}；已配置的客户端需要更新地址。`;
});

const texts = computed<Record<"claude" | "opencode" | "cursor" | "generic", string>>(() => ({
  claude: info.value?.commandLine ?? "",
  opencode: info.value?.opencodeJson ?? "",
  cursor: info.value?.cursorJson ?? "",
  generic: info.value?.url ?? "",
}));

const portDirty = computed(() => {
  if (!info.value) return false;
  const current = info.value.explicitPort;
  const raw = portInput.value.trim();
  if (raw === "") return current !== null;
  return Number(raw) !== current;
});

async function load(): Promise<void> {
  const next = await mcpSetup.ensure(true);
  message.value = next ? "" : "读取配置失败";
  portInput.value = next?.explicitPort === null || next?.explicitPort === undefined ? "" : String(next.explicitPort);
}

async function applyPort(): Promise<void> {
  const raw = portInput.value.trim();
  const port = raw === "" ? null : Number(raw);
  if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    message.value = "端口必须是 1024–65535 的整数";
    return;
  }
  saving.value = true;
  message.value = "";
  try {
    const next = await mcpSetup.savePort(port);
    portInput.value = next.explicitPort === null ? "" : String(next.explicitPort);
    message.value = next.listening ? "已应用，现有 agent 会话已断开" : (next.error ?? "端口已保存，但服务没有启动");
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}

function copy(kind: "claude" | "opencode" | "cursor" | "generic"): void {
  const text = texts.value[kind];
  if (!text) return;
  window.sqraft.app.copyText(text);
  copied.value = kind;
  window.setTimeout(() => {
    if (copied.value === kind) copied.value = null;
  }, 1400);
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

onMounted(() => {
  void load();
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="panel glass">
      <header>
        <h2>配置 MCP</h2>
        <button class="icon" title="关闭" @click="$emit('close')">✕</button>
      </header>

      <p class="lede">
        外部 agent（Claude Code、OpenCode、Cursor 等）通过本机 HTTP 端点连上 Sqraft。应用需要保持运行。
      </p>

      <section class="endpoint">
        <div class="label"><span>端点</span></div>
        <pre>{{ info?.url ?? "—" }}</pre>
        <p class="hint">只监听 127.0.0.1，没有凭据；不要把这个地址转发到其他机器。</p>
        <p class="status">{{ statusText }}</p>
        <p v-if="driftText" class="warn">{{ driftText }}</p>
      </section>

      <section class="port">
        <div class="label"><span>端口</span></div>
        <div class="port-row">
          <input
            v-model="portInput"
            inputmode="numeric"
            placeholder="留空 = 自动（7331 起）"
            spellcheck="false"
          />
          <button class="primary" :disabled="saving || !portDirty" @click="applyPort">
            {{ saving ? "应用中…" : "应用" }}
          </button>
        </div>
        <p class="hint">
          留空时从 7331 起，被占用会向上顺延并记住新端口；填 1024–65535 则严格使用，被占直接报错。改端口会断开现有
          agent 会话。
        </p>
      </section>

      <section>
        <div class="label">
          <span>Claude Code</span>
          <button class="copy" @click="copy('claude')">
            {{ copied === "claude" ? "已复制" : "复制" }}
          </button>
        </div>
        <pre>{{ texts.claude }}</pre>
      </section>

      <section>
        <div class="label">
          <span>OpenCode</span>
          <button class="copy" @click="copy('opencode')">
            {{ copied === "opencode" ? "已复制" : "复制" }}
          </button>
        </div>
        <pre>{{ texts.opencode }}</pre>
      </section>

      <section>
        <div class="label">
          <span>Cursor（~/.cursor/mcp.json）</span>
          <button class="copy" @click="copy('cursor')">
            {{ copied === "cursor" ? "已复制" : "复制" }}
          </button>
        </div>
        <pre>{{ texts.cursor }}</pre>
      </section>

      <section>
        <div class="label">
          <span>通用 URL</span>
          <button class="copy" @click="copy('generic')">
            {{ copied === "generic" ? "已复制" : "复制" }}
          </button>
        </div>
        <pre>{{ texts.generic }}</pre>
      </section>

      <p v-if="message" class="message">{{ message }}</p>
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

.panel {
  width: min(620px, calc(100vw - 48px));
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
  font-size: 11px;
  color: var(--text-faint);
  margin-bottom: 6px;
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

.copy:hover {
  color: var(--text);
  border-color: var(--hairline-strong);
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
