<script setup lang="ts">
import { onMounted, ref } from "vue";
import { newDocument, openDocument, openDocumentPath } from "../file-session";

const recent = ref<{ path: string; name: string }[]>([]);

async function refresh(): Promise<void> {
  recent.value = await window.sqraft.recent.list();
}

onMounted(() => {
  void refresh();
});

async function openRecent(path: string): Promise<void> {
  await openDocumentPath(path);
  // 失效条目会被主进程剔除，回来后重新取一次
  await refresh();
}
</script>

<template>
  <div class="welcome">
    <div class="card glass rise-in">
      <div class="brand">
        <span class="mark">S</span>
        <div class="titles">
          <h1>Sqraft</h1>
          <p>轻量、纯本地的 UI 设计工具</p>
        </div>
      </div>

      <div class="actions">
        <button class="primary" @click="newDocument">新建文档</button>
        <button class="ghost" @click="openDocument">打开…</button>
      </div>

      <div class="recent">
        <div class="recent-title">最近打开</div>
        <p v-if="recent.length === 0" class="empty">还没有打开过文件</p>
        <ul v-else>
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
</template>

<style scoped>
.welcome {
  height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
}

.card {
  width: min(560px, 100%);
  padding: 28px;
  border-radius: var(--radius-lg, 18px);
  display: flex;
  flex-direction: column;
  gap: 22px;
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
  margin-bottom: 8px;
}

.empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  overflow: auto;
}

.recent-item {
  width: 100%;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px;
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
</style>
