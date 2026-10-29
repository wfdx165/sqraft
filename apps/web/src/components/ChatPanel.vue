<script setup lang="ts">
/**
 * 左栏「对话」模块：历史会话（IndexedDB）+ 全局模型选择（底部输入区）。
 * 与 MCP 共用 packages/ai-tools 的工具定义（ADR-0004）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { makeExecutor, toOpenAITools } from "@sqraft/ai-tools";
import { ai, hasModels, selectModel, selectedProvider } from "../ai";
import { docStore, hooks, ui } from "../store";
import { textSizeOf } from "../text-metrics";
import { registerShortcuts } from "../shortcuts";
import {
  autoTitle,
  deleteSession,
  formatSessionTime,
  loadSession,
  loadSessionList,
  saveSession,
  type ChatMessage,
  type ContentPart,
  type Session,
  type SessionMeta,
} from "../sessions";
import Icon from "./Icon.vue";
import ProviderModal from "./ProviderModal.vue";

const SYSTEM_PROMPT =
  "你是 Sqraft 的设计助手。你可以调用工具直接编辑当前设计文档。" +
  "所有颜色必须使用 fillToken 引用设计 Token（先调用 get_tokens 查看）；禁止字面量色值。" +
  "创建界面后调用 screenshot 自检布局与视觉，必要时修正。回复使用中文。";

const MAX_ATTACH = 4;
const MAX_FILE_SIZE = 4 * 1024 * 1024;
const MAX_TEXTAREA_HEIGHT = 132;

const input = ref("");
const busy = ref(false);
const modalOpen = ref(false);
const historyOpen = ref(false);
const sessionList = ref<SessionMeta[]>([]);
const currentSession = ref<Session | null>(null);
const messages = ref<ChatMessage[]>([]);
const attachments = ref<{ id: string; name: string; dataUrl: string }[]>([]);
const attachError = ref("");
const textareaEl = ref<HTMLTextAreaElement | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);
let stopShortcuts = () => {};

const executor = makeExecutor(
  docStore,
  () => hooks.getScreenshot(),
  () => hooks.getActivePageId(),
  (node, style, text) => textSizeOf(node, style, text),
);

const selectedValue = computed(() => {
  if (!ai.selectedProviderId || !ai.selectedModel) return "";
  return `${ai.selectedProviderId}::${ai.selectedModel}`;
});

const modelsAvailable = computed(() => hasModels());

interface Row {
  who: "user" | "ai" | "tool";
  text: string;
}

function contentToText(content: ChatMessage["content"]): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content.map((p: ContentPart) => (p.type === "text" ? p.text : "[图片]")).join(" ");
}

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  for (const m of messages.value) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ who: "user", text: contentToText(m.content) });
    } else if (m.role === "assistant") {
      const text = contentToText(m.content);
      if (text) out.push({ who: "ai", text });
      for (const tc of m.tool_calls ?? []) {
        out.push({ who: "tool", text: `▸ ${tc.function.name} ${tc.function.arguments.slice(0, 64)}` });
      }
    } else if (m.role === "tool") {
      out.push({ who: "tool", text: `↩ ${contentToText(m.content).slice(0, 90)}` });
    }
  }
  return out;
});

function onSelectModel(e: Event) {
  const raw = (e.target as HTMLSelectElement).value;
  const idx = raw.indexOf("::");
  if (idx < 0) return;
  selectModel(raw.slice(0, idx), raw.slice(idx + 2));
}

function autoGrow() {
  const el = textareaEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
}

async function compressImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片读取失败"));
      image.src = url;
    });
    const maxEdge = 2048;
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
      });
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const g = canvas.getContext("2d");
    if (!g) throw new Error("画布不可用");
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function onFiles(e: Event) {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  (e.target as HTMLInputElement).value = "";
  attachError.value = "";
  for (const file of files) {
    if (attachments.value.length >= MAX_ATTACH) {
      attachError.value = `最多 ${MAX_ATTACH} 张图片`;
      break;
    }
    if (!file.type.startsWith("image/")) {
      attachError.value = "仅支持图片文件";
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      attachError.value = "单张图片不能超过 4MB";
      continue;
    }
    try {
      const dataUrl = await compressImage(file);
      attachments.value.push({ id: crypto.randomUUID(), name: file.name, dataUrl });
    } catch {
      attachError.value = "图片处理失败，换一张试试";
    }
  }
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((a) => a.id !== id);
}

async function refreshSessionList() {
  sessionList.value = await loadSessionList();
}

function newConversation() {
  currentSession.value = null;
  messages.value = [];
  attachments.value = [];
  input.value = "";
  historyOpen.value = false;
  void nextTick(autoGrow);
}

async function openSession(id: string) {
  const session = await loadSession(id);
  if (!session) return;
  currentSession.value = session;
  messages.value = session.messages;
  historyOpen.value = false;
}

async function removeSession(meta: SessionMeta) {
  if (!window.confirm(`删除会话「${meta.title}」？`)) return;
  await deleteSession(meta.id);
  if (currentSession.value?.id === meta.id) newConversation();
  await refreshSessionList();
}

async function persistCurrent() {
  const session = currentSession.value;
  if (!session) return;
  session.messages = messages.value;
  session.updatedAt = Date.now();
  // reactive 代理不能直接进 IndexedDB（结构化克隆会失败），先转纯对象
  const plain: Session = JSON.parse(JSON.stringify(session));
  await saveSession(plain);
  await refreshSessionList();
}

async function send() {
  const text = input.value.trim();
  const provider = selectedProvider();
  const hasImages = attachments.value.length > 0;
  if (busy.value || !provider || !ai.selectedModel || (!text && !hasImages)) return;

  if (!currentSession.value) {
    currentSession.value = {
      id: crypto.randomUUID(),
      title: autoTitle(text || "[图片]"),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
  }

  const content: ChatMessage["content"] = hasImages
    ? [
        { type: "text", text },
        ...attachments.value.map((a): ContentPart => ({ type: "image_url", image_url: { url: a.dataUrl } })),
      ]
    : text;

  input.value = "";
  attachments.value = [];
  attachError.value = "";
  void nextTick(autoGrow);
  messages.value.push({ role: "user", content });
  busy.value = true;
  try {
    for (let round = 0; round < 8; round++) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      const resp = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: ai.selectedModel,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages.value],
          tools: toOpenAITools(),
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      const msg = data.choices?.[0]?.message as ChatMessage | undefined;
      if (!msg) throw new Error("模型返回为空");
      messages.value.push(msg);
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* 参数解析失败按空处理，由工具层报错 */
          }
          let result: string;
          try {
            result = await executor(tc.function.name, args);
          } catch (e) {
            result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
          }
          messages.value.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        continue;
      }
      break;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = msg.includes("Failed to fetch") ? "（可能是浏览器跨域限制：该接入点未允许 CORS）" : "";
    messages.value.push({ role: "assistant", content: `⚠️ ${msg}${hint}` });
  } finally {
    busy.value = false;
    await persistCurrent();
  }
}

/** ⌘K 等全局命令由 shortcuts.ts 分发到这里；面板隐藏时也能唤出。 */
function focusChat() {
  ui.tab = "chat";
  void nextTick(() => textareaEl.value?.focus());
}

onMounted(() => {
  stopShortcuts = registerShortcuts({ "chat.focus": focusChat });
  void refreshSessionList();
});
onBeforeUnmount(() => {
  stopShortcuts();
});
</script>

<template>
  <div class="chat">
    <header class="top">
      <button class="history" :class="{ on: historyOpen }" @click="historyOpen = !historyOpen">
        历史对话<span v-if="sessionList.length" class="count">{{ sessionList.length }}</span>
      </button>
      <button class="new" @click="newConversation"><Icon name="plus" :size="12" />新建对话</button>
    </header>

    <div v-if="historyOpen" class="drawer-backdrop" @click.self="historyOpen = false">
      <div class="drawer">
        <div v-if="sessionList.length === 0" class="drawer-empty">还没有历史对话</div>
        <div
          v-for="s in sessionList"
          :key="s.id"
          class="session"
          :class="{ active: currentSession?.id === s.id }"
          @click="openSession(s.id)"
        >
          <span class="s-title">{{ s.title }}</span>
          <span class="s-time">{{ formatSessionTime(s.updatedAt) }}</span>
          <button class="s-del" title="删除会话" @click.stop="removeSession(s)"><Icon name="close" :size="11" /></button>
        </div>
      </div>
    </div>

    <div class="log">
      <div v-if="rows.length === 0" class="empty">
        <p>{{ currentSession ? "继续这段对话" : "描述你要的设计，我来画。" }}</p>
        <span>试试：「做一个登录卡片，用自动布局和 Token 配色」</span>
      </div>
      <div v-for="(m, i) in rows" :key="i" class="msg" :class="m.who">
        <span class="who">{{ m.who === "user" ? "你" : m.who === "tool" ? "工具" : "AI" }}</span>
        <span class="text">{{ m.text }}</span>
      </div>
    </div>

    <div v-if="!modelsAvailable" class="no-model">
      <p>还没有可用模型</p>
      <button class="primary" @click="modalOpen = true">添加 Provider</button>
    </div>

    <div class="composer">
      <div v-if="attachments.length" class="attachments">
        <div v-for="a in attachments" :key="a.id" class="thumb" :title="a.name">
          <img :src="a.dataUrl" :alt="a.name" />
          <button class="thumb-del" title="移除" @click="removeAttachment(a.id)"><Icon name="close" :size="9" /></button>
        </div>
      </div>
      <p v-if="attachError" class="attach-error">{{ attachError }}</p>

      <div class="input-wrap">
        <textarea
          ref="textareaEl"
          v-model="input"
          rows="1"
          class="msg-input"
          :placeholder="modelsAvailable ? '描述你想要的设计…' : '先添加一个 Provider'"
          :disabled="busy || !modelsAvailable"
          @input="autoGrow"
          @keydown.enter.exact.prevent="send"
        />
        <button
          class="send"
          :disabled="busy || !modelsAvailable || (!input.trim() && attachments.length === 0)"
          title="发送"
          @click="send"
        >
          <Icon name="arrow-up" :size="15" />
        </button>
      </div>

      <div class="tool-row">
        <button class="attach" :disabled="busy" @click="fileInputEl?.click()">
          <Icon name="paperclip" :size="13" />附件/图片
        </button>
        <input ref="fileInputEl" type="file" accept="image/*" multiple hidden @change="onFiles" />
        <div class="model-group">
          <select :value="selectedValue" :disabled="!modelsAvailable" title="选择模型（全局）" @change="onSelectModel">
            <option v-if="!modelsAvailable" value="">暂无模型</option>
            <optgroup v-for="p in ai.providers.filter((p) => p.models.length)" :key="p.id" :label="p.name">
              <option v-for="m in p.models" :key="p.id + m" :value="p.id + '::' + m">{{ m }}</option>
            </optgroup>
          </select>
          <button class="manage" @click="modalOpen = true">管理</button>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <ProviderModal v-if="modalOpen" @close="modalOpen = false" />
    </Teleport>
  </div>
</template>

<style scoped>
.chat {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  padding: 8px 10px 10px;
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--hairline);
}

.history,
.new {
  display: flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.history:hover,
.new:hover,
.history.on {
  background: rgba(15, 23, 42, 0.05);
  color: var(--text);
}

.count {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--text-faint);
}

.drawer-backdrop {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.drawer {
  margin: 44px 6px 0;
  max-height: 62%;
  overflow: auto;
  background: #ffffff;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-md);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.14);
  padding: 4px;
  animation: drawer-in 180ms var(--ease) both;
}

@keyframes drawer-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.drawer-empty {
  padding: 16px;
  text-align: center;
  font-size: 11.5px;
  color: var(--text-faint);
}

.session {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  cursor: default;
  transition: background var(--dur-fast) var(--ease);
}

.session:hover {
  background: rgba(15, 23, 42, 0.05);
}

.session.active {
  background: var(--accent-soft);
}

.s-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--text);
}

.s-time {
  flex: none;
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--text-faint);
}

.s-del {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}

.session:hover .s-del {
  opacity: 1;
}

.s-del:hover {
  color: var(--danger);
  background: rgba(214, 69, 69, 0.08);
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

.no-model {
  margin-bottom: 8px;
  padding: 10px;
  border: 1px dashed var(--hairline-strong);
  border-radius: var(--radius-md);
  text-align: center;
}

.no-model p {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--text-dim);
}

.primary {
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
  color: var(--text);
  border-radius: var(--radius-sm);
  padding: 5px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}

.primary:hover {
  background: rgba(79, 70, 229, 0.16);
}

/* 底部输入区：附件 + 多行输入 + 工具行 */
.composer {
  border-top: 1px solid var(--hairline);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attachments {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.thumb {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--hairline);
  background: rgba(15, 23, 42, 0.04);
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.thumb-del {
  position: absolute;
  top: 2px;
  right: 2px;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  background: rgba(15, 23, 42, 0.6);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}

.thumb:hover .thumb-del {
  opacity: 1;
}

.attach-error {
  margin: 0;
  font-size: 10.5px;
  color: var(--danger);
}

.input-wrap {
  position: relative;
}

.msg-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 38px;
  max-height: 132px;
  resize: none;
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid var(--hairline);
  border-radius: 14px;
  color: var(--text);
  padding: 9px 40px 9px 12px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.5;
  outline: none;
  overflow-y: auto;
  transition:
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

.msg-input:focus {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.msg-input:disabled {
  opacity: 0.6;
}

.send {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: var(--accent);
  color: #ffffff;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(79, 70, 229, 0.35);
  transition:
    transform var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}

.send:hover:not(:disabled) {
  transform: translateY(-1px);
  background: #443ad4;
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.42);
}

.send:active:not(:disabled) {
  transform: scale(0.96);
}

.send:disabled {
  background: rgba(15, 23, 42, 0.08);
  color: var(--text-faint);
  box-shadow: none;
  cursor: default;
}

.tool-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.attach {
  display: flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: var(--radius-sm);
  padding: 4px 6px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.attach:hover:not(:disabled) {
  background: rgba(15, 23, 42, 0.05);
  color: var(--text);
}

.attach:disabled {
  opacity: 0.5;
  cursor: default;
}

.model-group {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.model-group select {
  max-width: 128px;
  min-width: 0;
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 4px 6px;
  font-size: 10.5px;
  font-family: var(--mono);
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

.model-group select:focus {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.manage {
  border: none;
  background: transparent;
  color: var(--text-faint);
  border-radius: var(--radius-sm);
  padding: 4px 6px;
  font-size: 10.5px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.manage:hover {
  background: rgba(15, 23, 42, 0.05);
  color: var(--text);
}
</style>
