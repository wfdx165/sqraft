<script setup lang="ts">
/**
 * 对话面板（BYOK）：OpenAI 兼容接口 + 工具调用循环。
 * 与 MCP 共用 packages/ai-tools 的工具定义（ADR-0004）。
 */
import { ref } from "vue";
import { makeExecutor, toOpenAITools } from "@sqraft/ai-tools";
import { docStore, hooks } from "../store";

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
          log.value.push({ who: "tool", text: `▸ ${tc.function.name} ${JSON.stringify(args).slice(0, 80)}` });
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
</script>

<template>
  <section class="chat">
    <div class="head">
      <span class="title">AI 助手</span>
      <input v-model="cfg.baseUrl" class="cfg wide" placeholder="Base URL" />
      <input v-model="cfg.model" class="cfg" placeholder="model" />
      <input v-model="cfg.apiKey" class="cfg wide" placeholder="API Key（本地保存）" type="password" />
      <span class="hint">BYOK · 兼容 OpenAI 接口（DeepSeek/OpenAI/本地 Ollama）</span>
    </div>
    <div class="log">
      <div v-if="log.length === 0" class="empty">试试：帮我做一个登录页卡片，用自动布局</div>
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
      <button :disabled="busy || !input.trim()" @click="send">{{ busy ? "…" : "发送" }}</button>
    </div>
  </section>
</template>

<style scoped>
.chat {
  height: 170px;
  border-top: 1px solid #e2e2e6;
  background: #fff;
  display: flex;
  flex-direction: column;
  padding: 6px 10px;
  box-sizing: border-box;
}
.head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.title { font-size: 12px; font-weight: 600; color: #666; margin-right: 4px; }
.cfg { border: 1px solid #e2e2e6; border-radius: 4px; padding: 2px 6px; font-size: 11px; width: 120px; }
.cfg.wide { width: 200px; }
.hint { font-size: 10px; color: #aaa; margin-left: auto; }
.log { flex: 1; overflow: auto; font-size: 12px; }
.empty { color: #aaa; font-size: 12px; padding: 4px 0; }
.msg { display: flex; gap: 6px; padding: 2px 0; }
.who { min-width: 30px; color: #999; font-size: 11px; }
.msg.ai .who { color: #3366ff; }
.msg.tool .text { color: #888; font-family: ui-monospace, monospace; font-size: 11px; }
.input-row { display: flex; gap: 6px; margin-top: 4px; }
.msg-input { flex: 1; border: 1px solid #d5d5da; border-radius: 6px; padding: 4px 8px; font-size: 12px; }
button { border: 1px solid #3366ff; background: #3366ff; color: #fff; border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
button:disabled { opacity: 0.4; }
</style>
