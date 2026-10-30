<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { mcpSetup } from "../mcp-setup";

const emit = defineEmits<{ close: [] }>();

const info = mcpSetup.info;
const message = ref("");
const installing = ref(false);
const copied = ref<"claude" | "opencode" | "json" | "opencodeJson" | null>(null);

const commandLine = computed(() => info.value?.commandLine ?? "");
const opencodeCommand = computed(() => info.value?.opencodeCommand ?? "");
const json = computed(() => info.value?.json ?? "");
const opencodeJson = computed(() => info.value?.opencodeJson ?? "");

const texts = computed<Record<"claude" | "opencode" | "json" | "opencodeJson", string>>(() => ({
  claude: commandLine.value,
  opencode: opencodeCommand.value,
  json: json.value,
  opencodeJson: opencodeJson.value,
}));

async function install(): Promise<void> {
  installing.value = true;
  message.value = "";
  try {
    const result = await window.sqraft.mcp.installCli();
    message.value = result.message;
    // 写回共享 store：关掉面板后欢迎页的 CTA 立刻变成"复制接入命令"
    mcpSetup.set(result.info);
  } catch (error) {
    message.value = `安装失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    installing.value = false;
  }
}

function copy(kind: "claude" | "opencode" | "json" | "opencodeJson"): void {
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
  // 面板每次打开都重新核对磁盘上的软链（force）：CLI 可能被外部删掉或换过路径
  void mcpSetup.ensure(true);
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
        外部 agent（OpenCode、Claude Code、Cursor 等）通过下面的命令连上 Sqraft。应用没在运行时，客户端会自动把它拉起来。
      </p>

      <section>
        <div class="label">
          <span>OpenCode</span>
          <button class="copy" @click="copy('opencode')">
            {{ copied === "opencode" ? "已复制" : "复制" }}
          </button>
        </div>
        <pre>{{ opencodeCommand }}</pre>
      </section>

      <section>
        <div class="label">
          <span>Claude Code</span>
          <button class="copy" @click="copy('claude')">
            {{ copied === "claude" ? "已复制" : "复制" }}
          </button>
        </div>
        <pre>{{ commandLine }}</pre>
      </section>

      <section>
        <div class="label">
          <span>JSON · OpenCode（mcp.servers）</span>
          <button class="copy" @click="copy('opencodeJson')">
            {{ copied === "opencodeJson" ? "已复制" : "复制" }}
          </button>
        </div>
        <pre>{{ opencodeJson }}</pre>
      </section>

      <section>
        <div class="label">
          <span>JSON · Claude / 通用（mcpServers）</span>
          <button class="copy" @click="copy('json')">
            {{ copied === "json" ? "已复制" : "复制" }}
          </button>
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
