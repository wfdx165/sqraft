<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { docStore, redo, switchMode, ui, undo, type ToolKind } from "../store";
import { openDocument, saveDocument, saveDocumentAs } from "../file-session";
import { keyOf, PANEL_BINDING, registerShortcuts, shortcutUi, type ActionId } from "../shortcuts";
import { vTip } from "../tooltip";
import Icon from "./Icon.vue";

const tools: { kind: ToolKind; action: ActionId; label: string; icon: string }[] = [
  { kind: "select", action: "mode.edit", label: "选择", icon: "select" },
  { kind: "frame", action: "tool.frame", label: "画板", icon: "frame" },
  { kind: "rect", action: "tool.rect", label: "矩形", icon: "rect" },
  { kind: "ellipse", action: "tool.ellipse", label: "椭圆", icon: "ellipse" },
  { kind: "triangle", action: "tool.triangle", label: "三角形", icon: "triangle" },
  { kind: "line", action: "tool.line", label: "直线", icon: "line" },
  { kind: "path", action: "tool.path", label: "钢笔", icon: "pen" },
  { kind: "text", action: "tool.text", label: "文本", icon: "text" },
];

/** 点绘图工具自动切到编辑模式（模式分离：拖动模式只浏览） */
function pickTool(kind: ToolKind) {
  switchMode("edit");
  ui.tool = kind;
}

async function onOpen() {
  await openDocument();
}
async function onSave() {
  await saveDocument();
}
async function onSaveAs() {
  await saveDocumentAs();
}

function toggleShortcuts() {
  shortcutUi.open = !shortcutUi.open;
  shortcutUi.recording = null;
  shortcutUi.error = "";
}

let unregister = () => {};
onMounted(() => {
  unregister = registerShortcuts({ "file.open": onOpen, "file.save": onSave, "file.saveAs": onSaveAs });
});
onBeforeUnmount(() => unregister());
</script>

<template>
  <header class="bar glass">
    <span class="brand"><span class="mark" />Sqraft</span>

    <nav class="group modes">
      <button
        class="mode-btn"
        :class="{ active: ui.mode === 'pan' }"
        v-tip="{ label: '拖动画布', shortcut: keyOf('mode.pan') }"
        @click="switchMode('pan')"
      >
        <Icon name="hand" :size="13" /><span>拖动</span>
      </button>
      <button
        class="mode-btn"
        :class="{ active: ui.mode === 'edit' }"
        v-tip="{ label: '编辑页面', shortcut: keyOf('mode.edit') }"
        @click="switchMode('edit')"
      >
        <Icon name="select" :size="13" /><span>编辑</span>
      </button>
    </nav>

    <span class="divider" />

    <nav class="group">
      <button
        v-for="t in tools"
        :key="t.kind"
        class="icon-btn"
        :class="{ active: ui.mode === 'edit' && ui.tool === t.kind }"
        v-tip="{ label: t.label, shortcut: keyOf(t.action) }"
        @click="pickTool(t.kind)"
      >
        <Icon :name="t.icon" />
      </button>
    </nav>
    <span class="divider" />
    <nav class="group">
      <button class="icon-btn" v-tip="{ label: '撤销', shortcut: keyOf('edit.undo') }" :disabled="!docStore.canUndo" @click="undo">
        <Icon name="undo" />
      </button>
      <button class="icon-btn" v-tip="{ label: '重做', shortcut: keyOf('edit.redo') }" :disabled="!docStore.canRedo" @click="redo">
        <Icon name="redo" />
      </button>
    </nav>
    <span class="divider" />
    <nav class="group">
      <button class="icon-btn" v-tip="{ label: '打开', shortcut: keyOf('file.open') }" @click="onOpen"><Icon name="open" /></button>
      <button class="icon-btn" v-tip="{ label: '保存', shortcut: keyOf('file.save') }" @click="onSave"><Icon name="save" /></button>
    </nav>
    <span class="divider" />

    <button
      class="icon-btn"
      :class="{ active: shortcutUi.open }"
      data-shortcuts-toggle
      v-tip="{ label: '键盘快捷键', shortcut: PANEL_BINDING }"
      @click="toggleShortcuts"
    >
      <Icon name="keyboard" />
    </button>
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

/* 模式分段：拖动 / 编辑 */
.modes {
  gap: 1px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--tint-4);
  border: 1px solid var(--hairline);
}

.mode-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 9px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

.mode-btn:hover {
  color: var(--text);
}

.mode-btn.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 3px var(--tint-12);
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
