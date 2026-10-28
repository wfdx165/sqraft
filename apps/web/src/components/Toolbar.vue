<script setup lang="ts">
import { docStore, redo, ui, undo, type ToolKind } from "../store";
import { openWithPicker, saveWithPicker } from "../fileio";

const tools: { kind: ToolKind; label: string; key: string }[] = [
  { kind: "select", label: "选择", key: "V" },
  { kind: "frame", label: "画板", key: "F" },
  { kind: "rect", label: "矩形", key: "R" },
  { kind: "ellipse", label: "椭圆", key: "O" },
  { kind: "line", label: "直线", key: "L" },
  { kind: "text", label: "文本", key: "T" },
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
  <header class="bar">
    <span class="brand">Sqraft</span>
    <button v-for="t in tools" :key="t.kind" :class="{ active: ui.tool === t.kind }" @click="ui.tool = t.kind">
      {{ t.label }}<kbd>{{ t.key }}</kbd>
    </button>
    <span class="sep" />
    <button :disabled="!docStore.canUndo" @click="undo">撤销</button>
    <button :disabled="!docStore.canRedo" @click="redo">重做</button>
    <span class="spacer" />
    <button @click="onOpen">打开</button>
    <button @click="onSave">保存</button>
  </header>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: #fff;
  border-bottom: 1px solid #e2e2e6;
}
.brand { font-weight: 700; margin-right: 10px; letter-spacing: 0.3px; }
button {
  border: 1px solid #d5d5da;
  background: #fff;
  border-radius: 6px;
  padding: 4px 9px;
  font-size: 12px;
  cursor: pointer;
}
button:hover:not(:disabled) { background: #f0f0f3; }
button:disabled { opacity: 0.4; cursor: default; }
button.active { background: #3366ff; color: #fff; border-color: #3366ff; }
kbd { font-size: 9px; opacity: 0.6; margin-left: 3px; }
.sep { width: 1px; height: 18px; background: #e2e2e6; margin: 0 4px; }
.spacer { flex: 1; }
</style>
