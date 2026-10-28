<script setup lang="ts">
/**
 * 对话面板（BYOK）：悬浮胶囊 ⇄ 玻璃卡片，⌘K 切换。
 * 与 MCP 共用 packages/ai-tools 的工具定义（ADR-0004）。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { makeExecutor, toOpenAITools } from "@sqraft/ai-tools";
import { docStore, hooks } from "../store";
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

const open = ref(false);
const cfg = ref({
  baseUrl: localStorage.getItem("sqraft.baseUrl") ?? "https://api.deepseek.com",
  apiKey: localStorage.getItem("sqraft.apiKey") ?? "",
  model: localStorage.getItem("sqraft.model") ?? "deepseek-chat",
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

const executor = makeExecutor(docStore, () => hooks.getScreenshot());

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
      const resp = await fetch(`${cfg.value.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.value.apiKey}` },
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
          log.value.push({ who: "tool", text: `▸ ${tc.function.name} ${JSON.stringify(args).slice(0, 72)}` });
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
    open.value = !open.value;
  } else if (e.key === "Escape" && open.value) {
    open.value = false;
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <!-- 收起态：悬浮胶囊 -->
  <button v-if="!open" class="capsule glass" @click="open = true">
    <Icon name="send" :size="13" />
    <span>Ask Sqraft…</span>
    <kbd>⌘K</kbd>
  </button>

  <!-- 展开态：玻璃卡片 -->
  <section v-else class="card glass">
    <header>
      <span class="micro-label">AI 助手</span>
      <span class="dot" />
      <span class="hint">BYOK · OpenAI 兼容</span>
      <button class="close" title="收起 (Esc)" @click="open = false"><Icon name="close" :size="13" /></button>
    </header>

    <div class="cfg">
      <input v-model="cfg.baseUrl" placeholder="Base URL" />
      <input v-model="cfg.model" placeholder="model" />
      <input v-model="cfg.apiKey" type="password" placeholder="API Key（仅存本地）" />
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
      <button class="send" :disabled="busy || !input.trim()" @click="send" title="发送">
        <span class="ring"><Icon name="send" :size="12" /></span>
      </button>
    </div>
  </section>
</template>

<style scoped>
/* 收起态 */
.capsule {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 16px;
  border-radius: var(--radius-pill);
  color: var(--text-dim);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition:
    transform var(--dur-med) var(--ease),
    color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}

.capsule:hover {
  color: var(--text);
  border-color: var(--hairline-strong);
  transform: translateY(-1px);
}

.capsule:active {
  transform: scale(0.98);
}

.capsule kbd {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-faint);
  border: 1px solid var(--hairline);
  border-radius: 5px;
  padding: 1px 5px;
}

/* 展开态 */
.card {
  width: 620px;
  max-width: calc(100vw - 48px);
  display: flex;
  flex-direction: column;
  padding: 12px 14px 14px;
  box-sizing: border-box;
  animation: card-in 420ms var(--ease) both;
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
}

.dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}

.hint {
  font-size: 10.5px;
  color: var(--text-faint);
}

.close {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.close:hover {
  background: var(--glass-strong);
  color: var(--text);
}

.cfg {
  display: flex;
  gap: 8px;
  padding-bottom: 10px;
}

.cfg input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 5px 9px;
  font-size: 11.5px;
  font-family: var(--mono);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

.cfg input:focus {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.log {
  height: 168px;
  overflow: auto;
  border-top: 1px solid var(--hairline);
  border-bottom: 1px solid var(--hairline);
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
  font-size: 12.5px;
  color: var(--text-dim);
}

.empty span {
  font-size: 11px;
}

.msg {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.55;
}

.who {
  flex: none;
  width: 26px;
  font-size: 10px;
  color: var(--text-faint);
  padding-top: 2px;
}

.msg.ai .who {
  color: var(--accent);
}

.msg.tool .text {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 10.5px;
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
  gap: 8px;
  padding-top: 10px;
}

.msg-input {
  flex: 1;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
  color: var(--text);
  padding: 8px 14px;
  font-size: 12.5px;
  font-family: inherit;
  outline: none;
  transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

.msg-input:focus {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.send {
  display: grid;
  place-items: center;
  padding: 6px;
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
  color: var(--text);
  border-radius: 50%;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
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
