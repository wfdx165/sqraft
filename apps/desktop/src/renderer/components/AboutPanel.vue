<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { AppInfo } from "../../shared/ipc";

const emit = defineEmits<{ close: [] }>();
const info = ref<AppInfo | null>(null);
const copied = ref(false);

onMounted(async () => {
  info.value = await window.sqraft.app.info();
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

function copyPath(): void {
  if (!info.value) return;
  window.sqraft.app.copyText(info.value.dataPath);
  copied.value = true;
  window.setTimeout(() => (copied.value = false), 1400);
}
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="panel glass">
      <header>
        <h2>关于 Sqraft</h2>
        <button class="icon" title="关闭" @click="$emit('close')">✕</button>
      </header>

      <div class="brand">
        <span class="mark">S</span>
        <div>
          <p class="name">Sqraft</p>
          <p class="version">版本 {{ info?.version ?? "—" }}</p>
        </div>
      </div>

      <dl>
        <dt>Electron</dt>
        <dd>{{ info?.electron ?? "—" }}</dd>
        <dt>Chromium</dt>
        <dd>{{ info?.chrome ?? "—" }}</dd>
      </dl>

      <section>
        <div class="label">
          <span>数据目录</span>
          <button class="copy" @click="copyPath">{{ copied ? "已复制" : "复制路径" }}</button>
        </div>
        <p class="path">{{ info?.dataPath ?? "—" }}</p>
      </section>

      <p class="foot">纯本地应用：设计稿以 .sqraft 文件保存在磁盘上，文档不会离开这台机器。</p>
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
  width: min(460px, calc(100vw - 48px));
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
  background: var(--tint-5);
  color: var(--text);
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mark {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  background: var(--accent);
  color: #fff;
  font-size: 20px;
  font-weight: 600;
}

.name {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.version {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--text-dim);
}

dl {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 6px 10px;
  margin: 0;
  font-size: 11.5px;
}

dt {
  color: var(--text-faint);
}

dd {
  margin: 0;
  color: var(--text);
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

.path {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--tint-4);
  border: 1px solid var(--hairline);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  word-break: break-all;
}

.foot {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}
</style>
