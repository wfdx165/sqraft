<script setup lang="ts">
/**
 * 左栏「对话」模块（BYOK，纯手填接入点）。
 * 与 MCP 共用 packages/ai-tools 的工具定义（ADR-0004）。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { makeExecutor, toOpenAITools } from "@sqraft/ai-tools";
import { currentPageId, docStore, hooks, ui } from "../store";
import Icon from "./Icon.vue";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

const cfg = ref({
  baseUrl: localStorage.getItem("sqraft.baseUrl") ?? "https://opencode.ai/zen/go/v1",
  apiKey: localStorage.getItem("sqraft.apiKey") ?? "",
  model: localStorage.getItem("sqraft.model") ?? "glm-5.3",
});
const input = ref("");
const busy = ref(false);
const log = ref<{ who: "user" | "ai" | "tool"; text: string }[]>([]);
const messages: ChatMessage[] = [
  {
    role: "system",
    content:
      "你是 Sqraft 的设计助手。你可以调用工具直接编辑当前设计文档。" +
      "所有颜色必须使用 fillToken 引用设计 Token（先调用 get_tokens 查看）；禁止字面量色值。" +
      "创建界面后调用 screenshot 自检布局与视觉，必要时修正。回复使用中文。",
  },
];

const executor = makeExecutor(docStore, () => hooks.getScreenshot(), () => currentPageId());

function saveCfg() {
  localStorage.setItem("sqraft.baseUrl", cfg.value.baseUrl);
  localStorage.setItem("sqraft.apiKey", cfg.value.apiKey);
  localStorage.setItem("sqraft.model", cfg.value.model);
}

async function send() {
  const text = input.value.trim();
  if (!text || busy.value) return;
  saveCfg();
  input.value = "";
  log.value.push({ who: "user", text });
  messages.push({ role: "user", content: text });
  busy.value = true;
  try {
    for (let round = 0; round < 8; round++) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (cfg.value.apiKey) headers.Authorization = `Bearer ${cfg.value.apiKey}`;
      const resp = await fetch(`${cfg.value.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: cfg.value.model, messages, tools: toOpenAITools() }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      const msg: ChatMessage = data.choices?.[0]?.message;
      if (!msg) throw new Error("模型返回为空");
      messages.push(msg);
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* 参数解析失败按空处理，由工具层报错 */
          }
          log.value.push({ who: "tool", text: `▸ ${tc.function.name} ${JSON.stringify(args).slice(0, 64)}` });
          let result: string;
          try {
            result = await executor(tc.function.name, args);
          } catch (e) {
            result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
          }
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        continue;
      }
      if (msg.content) log.value.push({ who: "ai", text: msg.content });
      break;
    }
  } catch (e) {
    log.value.push({ who: "ai", text: `⚠️ ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    busy.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    ui.tab = "chat";
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="chat">
    <div class="cfg">
      <label>
        <span>接入点</span>
        <input v-model="cfg.baseUrl" placeholder="https://opencode.ai/zen/go/v1" />
      </label>
      <label>
        <span>模型</span>
        <input v-model="cfg.model" placeholder="glm-5.3" />
      </label>
      <label>
        <span>API Key</span>
        <input v-model="cfg.apiKey" type="password" placeholder="可选（key 仅存本地）" />
      </label>
      <p class="hint">OpenAI 兼容接口。示例：OpenCode Go / DeepSeek / 本地 Ollama（http://localhost:11434/v1）</p>
    </div>

    <div class="log">
      <div v-if="log.length === 0" class="empty">
        <p>描述你要的设计，我来画。</p>
        <span>试试：「做一个登录卡片，用自动布局和 Token 配色」</span>
      </div>
      <div v-for="(m, i) in log" :key="i" class="msg" :class="m.who">
        <span class="who">{{ m.who === "user" ? "你" : m.who === "tool" ? "工具" : "AI" }}</span>
        <span class="text">{{ m.text }}</span>
      </div>
    </div>

    <div class="input-row">
      <input
        v-model="input"
        class="msg-input"
        placeholder="描述你想要的设计…"
        :disabled="busy"
        @keydown.enter.prevent="send"
      />
      <button class="send" :disabled="busy || !input.trim()" title="发送" @click="send">
        <span class="ring"><Icon name="send" :size="12" /></span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  padding: 4px 10px 10px;
}

.cfg {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--hairline);
}

.cfg label {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cfg label span {
  flex: none;
  width: 44px;
  font-size: 10.5px;
  color: var(--text-faint);
}

.cfg input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 5px 8px;
  font-size: 11px;
  font-family: var(--mono);
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

.cfg input:focus {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.hint {
  margin: 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-faint);
}

.log {
  flex: 1;
  overflow: auto;
  padding: 10px 2px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.empty {
  margin: auto;
  text-align: center;
  color: var(--text-faint);
}

.empty p {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--text-dim);
}

.empty span {
  font-size: 10.5px;
  line-height: 1.6;
}

.msg {
  display: flex;
  gap: 8px;
  font-size: 11.5px;
  line-height: 1.55;
}

.who {
  flex: none;
  width: 24px;
  font-size: 9.5px;
  color: var(--text-faint);
  padding-top: 2px;
}

.msg.ai .who {
  color: var(--accent);
}

.msg.tool .text {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 10px;
}

.text {
  flex: 1;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}

.msg.user .text {
  color: var(--text);
}

.input-row {
  display: flex;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--hairline);
}

.msg-input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
  color: var(--text);
  padding: 7px 12px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

.msg-input:focus {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.send {
  display: grid;
  place-items: center;
  padding: 5px;
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
  color: var(--text);
  border-radius: 50%;
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}

.send:hover:not(:disabled) {
  background: rgba(124, 127, 242, 0.24);
}

.send:active:not(:disabled) {
  transform: scale(0.97);
}

.send:disabled {
  opacity: 0.35;
  cursor: default;
}

.ring {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  transition: transform var(--dur-fast) var(--ease);
}

.send:hover:not(:disabled) .ring {
  transform: translate(1px, -1px) scale(1.05);
}
</style>
