<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import {
  addProvider,
  ai,
  fetchProviderModels,
  OPENCODE_TEMPLATE,
  removeProvider,
  updateProvider,
  type Provider,
} from "../ai";

const emit = defineEmits<{ close: [] }>();

const view = ref<"list" | "form">("list");
const editingId = ref<string | null>(null);
const form = ref({ name: "", baseUrl: "", apiKey: "", modelsText: "" });
const error = ref("");
const fetching = ref(false);
const addMenuOpen = ref(false);

function startCustom() {
  editingId.value = null;
  form.value = { name: "", baseUrl: "", apiKey: "", modelsText: "" };
  error.value = "";
  addMenuOpen.value = false;
  view.value = "form";
}

function addPreset() {
  addProvider({ ...OPENCODE_TEMPLATE, models: [...OPENCODE_TEMPLATE.models] });
  addMenuOpen.value = false;
}

function startEdit(provider: Provider) {
  editingId.value = provider.id;
  form.value = {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelsText: provider.models.join("\n"),
  };
  error.value = "";
  view.value = "form";
}

function parseModels(text: string): string[] {
  return [...new Set(text.split("\n").map((s) => s.trim()).filter(Boolean))];
}

function save() {
  const name = form.value.name.trim();
  const baseUrl = form.value.baseUrl.trim();
  if (!name || !baseUrl) {
    error.value = "名称与接入点必填";
    return;
  }
  const models = parseModels(form.value.modelsText);
  const apiKey = form.value.apiKey.trim();
  if (editingId.value) updateProvider(editingId.value, { name, baseUrl, apiKey, models });
  else addProvider({ name, baseUrl, apiKey, models });
  editingId.value = null;
  error.value = "";
  view.value = "list";
}

async function pullModels() {
  error.value = "";
  fetching.value = true;
  try {
    const models = await fetchProviderModels(form.value.baseUrl.trim(), form.value.apiKey.trim());
    form.value.modelsText = models.join("\n");
  } catch (e) {
    error.value = `拉取失败：${e instanceof Error ? e.message : String(e)}（可手工填写模型名）`;
  } finally {
    fetching.value = false;
  }
}

function onRemove(provider: Provider) {
  if (!window.confirm(`删除 Provider「${provider.name}」及其模型列表？`)) return;
  removeProvider(provider.id);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal">
      <header>
        <span class="title">{{ view === "list" ? "Provider 管理" : editingId ? "编辑 Provider" : "添加 Provider" }}</span>
        <button class="close" title="关闭 (Esc)" @click="emit('close')"><Icon name="close" :size="13" /></button>
      </header>

      <template v-if="view === 'list'">
        <div class="list">
          <div v-for="p in ai.providers" :key="p.id" class="item">
            <div class="info">
              <span class="name">{{ p.name }}</span>
              <span class="url">{{ p.baseUrl }}</span>
              <span class="meta">{{ p.models.length }} 个模型</span>
            </div>
            <button class="ghost" title="编辑" @click="startEdit(p)">编辑</button>
            <button class="ghost danger" title="删除" @click="onRemove(p)">删除</button>
          </div>
          <div v-if="ai.providers.length === 0" class="empty">还没有 Provider。</div>
        </div>
        <footer>
          <template v-if="addMenuOpen">
            <button class="ghost" @click="addMenuOpen = false">取消</button>
            <button class="primary" @click="addPreset">OpenCode Go（预置）</button>
            <button class="primary" @click="startCustom">自定义接入点</button>
          </template>
          <button v-else class="primary" @click="addMenuOpen = true">＋ 添加 Provider</button>
        </footer>
      </template>

      <template v-else>
        <div class="form">
          <label>
            <span>名称</span>
            <input v-model="form.name" placeholder="例如 OpenCode / DeepSeek" />
          </label>
          <label>
            <span>接入点</span>
            <input v-model="form.baseUrl" placeholder="https://opencode.ai/zen/go/v1" />
          </label>
          <label>
            <span>API Key</span>
            <input v-model="form.apiKey" type="password" placeholder="可选（仅存本地）" />
          </label>
          <label>
            <span>模型</span>
            <textarea v-model="form.modelsText" rows="5" placeholder="每行一个模型名，如 glm-5.3" spellcheck="false" />
          </label>
          <div class="form-actions">
            <button class="ghost" :disabled="fetching" @click="pullModels">
              {{ fetching ? "拉取中…" : "从端点拉取模型" }}
            </button>
          </div>
          <p v-if="error" class="error">{{ error }}</p>
        </div>
        <footer>
          <button class="ghost" @click="view = 'list'">取消</button>
          <button class="primary" @click="save">保存</button>
        </footer>
      </template>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.32);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}

.modal {
  width: 460px;
  max-width: calc(100vw - 48px);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 72px rgba(15, 23, 42, 0.22);
  animation: modal-in 220ms var(--ease) both;
}

@keyframes modal-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 14px 10px;
}

.title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.close {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
}

.close:hover {
  background: rgba(15, 23, 42, 0.06);
  color: var(--text);
}

.list {
  overflow: auto;
  padding: 0 14px;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  border-top: 1px solid var(--hairline);
}

.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
}

.url {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  font-size: 10.5px;
  color: var(--text-faint);
}

.empty {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-faint);
}

.form {
  overflow: auto;
  padding: 0 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form label {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.form label span {
  font-size: 10.5px;
  color: var(--text-faint);
}

input,
textarea {
  width: 100%;
  box-sizing: border-box;
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 7px 10px;
  font-size: 12px;
  font-family: var(--mono);
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

textarea {
  resize: vertical;
  min-height: 84px;
  line-height: 1.5;
}

input:focus,
textarea:focus {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
}

.error {
  margin: 0;
  font-size: 11px;
  color: var(--danger);
  line-height: 1.5;
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--hairline);
  margin-top: 10px;
}

button.ghost,
button.primary {
  border-radius: var(--radius-sm);
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}

button.ghost {
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
}

button.ghost:hover:not(:disabled) {
  background: rgba(15, 23, 42, 0.05);
  color: var(--text);
}

button.ghost.danger:hover {
  border-color: rgba(214, 69, 69, 0.4);
  color: var(--danger);
  background: rgba(214, 69, 69, 0.06);
}

button.primary {
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
  color: var(--text);
}

button.primary:hover {
  background: rgba(79, 70, 229, 0.16);
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
