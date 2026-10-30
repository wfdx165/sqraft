<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { McpSetupInfo } from "../../shared/ipc";

const emit = defineEmits<{ close: [] }>();

const info = ref<McpSetupInfo | null>(null);
const message = ref("");
const installing = ref(false);
const copied = ref<"command" | "json" | null>(null);

const commandLine = computed(() => info.value?.commandLine ?? "");
const json = computed(() => info.value?.json ?? "");

async function load(): Promise<void> {
  info.value = await window.sqraft.mcp.setup();
}

async function install(): Promise<void> {
  installing.value = true;
  message.value = "";
  try {
    const result = await window.sqraft.mcp.installCli();
    message.value = result.message;
    info.value = result.info;
  } finally {
    installing.value = false;
  }
}

function copy(kind: "command" | "json"): void {
  const text = kind === "command" ? commandLine.value : json.value;
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
        外部 agent（Claude Code、Cursor 等）通过下面的命令连上 Sqraft。应用没在运行时，客户端会自动把它拉起来。
      </p>

      <section>
        <div class="label">
          <span>Claude Code</span>
          <button class="copy" @click="copy('command')">{{ copied === "command" ? "已复制" : "复制" }}</button>
        </div>
        <pre>{{ commandLine }}</pre>
      </section>

      <section>
        <div class="label">
          <span>通用 JSON 配置</span>
          <button class="copy" @click="copy('json')">{{ copied === "json" ? "已复制" : "复制" }}</button>
        </div>
        <pre>{{ json }}</pre>
      </section>

      <section class="install">
        <div>
          <div class="label"><span>命令行工具</span></div>
          <p class="hint">
            {{
              info?.installed
                ? `已安装：${info.installedPath}`
                : `可以把 sqraft-mcp 装进 ${info?.targetDir ?? "PATH"}，配置里就不用写绝对路径。`
            }}
          </p>
        </div>
        <button class="primary" :disabled="installing || info?.installed" @click="install">
          {{ info?.installed ? "已安装" : installing ? "安装中…" : "安装到 PATH" }}
        </button>
      </section>

      <p v-if="message" class="message">{{ message }}</p>
      <p class="foot">需要让应用保持运行，或直接让 agent 拉起它。</p>
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

.install {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-dim);
  word-break: break-all;
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

.foot {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
}
</style>
