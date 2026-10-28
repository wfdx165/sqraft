<script setup lang="ts">
import { docStore, redo, ui, undo, type ToolKind } from "../store";
import { openWithPicker, saveWithPicker } from "../fileio";
import Icon from "./Icon.vue";

const tools: { kind: ToolKind; label: string; icon: string; key: string }[] = [
  { kind: "select", label: "选择", icon: "select", key: "V" },
  { kind: "frame", label: "画板", icon: "frame", key: "F" },
  { kind: "rect", label: "矩形", icon: "rect", key: "R" },
  { kind: "ellipse", label: "椭圆", icon: "ellipse", key: "O" },
  { kind: "line", label: "直线", icon: "line", key: "L" },
  { kind: "text", label: "文本", icon: "text", key: "T" },
];

async function onOpen() {
  const state = await openWithPicker();
  if (state) docStore.replace(state);
}
async function onSave() {
  await saveWithPicker(docStore.snapshot());
}
</script>

<template>
  <header class="bar glass">
    <span class="brand"><span class="mark" />Sqraft</span>
    <nav class="group">
      <button
        v-for="t in tools"
        :key="t.kind"
        class="icon-btn"
        :class="{ active: ui.tool === t.kind }"
        :title="`${t.label} (${t.key})`"
        @click="ui.tool = t.kind"
      >
        <Icon :name="t.icon" />
      </button>
    </nav>
    <span class="divider" />
    <nav class="group">
      <button class="icon-btn" title="撤销 (⌘Z)" :disabled="!docStore.canUndo" @click="undo"><Icon name="undo" /></button>
      <button class="icon-btn" title="重做 (⇧⌘Z)" :disabled="!docStore.canRedo" @click="redo"><Icon name="redo" /></button>
    </nav>
    <span class="divider" />
    <nav class="group">
      <button class="icon-btn" title="打开 (⌘O)" @click="onOpen"><Icon name="open" /></button>
      <button class="icon-btn" title="保存 (⌘S)" @click="onSave"><Icon name="save" /></button>
    </nav>
  </header>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-pill);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 6px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}

.mark {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  background: linear-gradient(135deg, #8b8df5, #5b5fe8);
  box-shadow: 0 0 14px rgba(124, 127, 242, 0.5);
}

.group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}

.icon-btn:hover:not(:disabled) {
  background: var(--glass-strong);
  color: var(--text);
}

.icon-btn:active:not(:disabled) {
  transform: scale(0.94);
}

.icon-btn.active {
  background: var(--glass-strong);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
  position: relative;
}

.icon-btn.active::after {
  content: "";
  position: absolute;
  bottom: 3px;
  left: 50%;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
  transform: translateX(-50%);
  box-shadow: 0 0 8px var(--accent);
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.divider {
  width: 1px;
  height: 18px;
  background: var(--hairline);
  margin: 0 2px;
}
</style>
