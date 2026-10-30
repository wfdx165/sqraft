<script setup lang="ts">
/**
 * 快捷键面板：居中的对话框（不是贴着工具条的小浮层）。
 * 点击键位就地录制；Esc、点遮罩或右上角 × 关闭；冲突/保留键当场拒绝并提示。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  ACTIONS,
  FIXED_HINTS,
  GROUP_ORDER,
  bindingOfEvent,
  isDefault,
  keyOf,
  resetAll,
  setBinding,
  shortcutUi,
  validateBinding,
  type ActionGroup,
} from "../shortcuts";
import Icon from "./Icon.vue";

const confirmReset = ref(false);
let confirmTimer = 0;

const groups = computed<{ group: ActionGroup; items: typeof ACTIONS }[]>(() =>
  GROUP_ORDER.map((group) => ({ group, items: ACTIONS.filter((a) => a.group === group) })).filter(
    (g) => g.items.length > 0,
  ),
);

const changed = computed(() => ACTIONS.some((a) => !isDefault(a.id)));

function close() {
  shortcutUi.open = false;
  stopRecord();
}

function startRecord(id: (typeof ACTIONS)[number]["id"]) {
  shortcutUi.recording = id;
  shortcutUi.error = "";
}

function stopRecord() {
  shortcutUi.recording = null;
  shortcutUi.error = "";
}

/** 录制期间吃掉所有按键；Esc 取消，非法组合留在录制态等下一次。 */
function onKeydownCapture(e: KeyboardEvent) {
  if (shortcutUi.recording) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      stopRecord();
      return;
    }
    const binding = bindingOfEvent(e);
    if (!binding) return;
    const error = validateBinding(shortcutUi.recording, binding);
    if (error) {
      shortcutUi.error = error;
      return;
    }
    setBinding(shortcutUi.recording, binding);
    stopRecord();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    close();
  }
}

function onReset() {
  if (!confirmReset.value) {
    confirmReset.value = true;
    window.clearTimeout(confirmTimer);
    confirmTimer = window.setTimeout(() => (confirmReset.value = false), 3000);
    return;
  }
  window.clearTimeout(confirmTimer);
  confirmReset.value = false;
  resetAll();
  stopRecord();
}

onMounted(() => {
  window.addEventListener("keydown", onKeydownCapture, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydownCapture, true);
  window.clearTimeout(confirmTimer);
});
</script>

<template>
  <div class="kb-overlay" @pointerdown.self="close">
    <div class="kb-dialog glass" role="dialog" aria-label="键盘快捷键" @pointerdown.stop>
      <header class="head">
        <div class="titles">
          <span class="title">键盘快捷键</span>
          <span class="hint">{{ shortcutUi.recording ? "按下新的组合键…" : "点击任意键位即可修改" }}</span>
        </div>
        <button class="close" aria-label="关闭" @click="close"><Icon name="close" :size="14" /></button>
      </header>

      <div class="cols">
        <section v-for="g in groups" :key="g.group" class="group">
          <span class="micro-label">{{ g.group }}</span>
          <div
            v-for="a in g.items"
            :key="a.id"
            class="row"
            :class="{ recording: shortcutUi.recording === a.id }"
            @click="startRecord(a.id)"
          >
            <span class="label">{{ a.label }}</span>
            <span v-if="shortcutUi.recording === a.id" class="kbd recording-kbd">按下…</span>
            <span v-else class="kbd" :class="{ custom: !isDefault(a.id) }">{{ keyOf(a.id) }}</span>
          </div>
        </section>
      </div>

      <p v-if="shortcutUi.error" class="error">{{ shortcutUi.error }}</p>

      <footer class="foot">
        <div class="fixed">
          <span v-for="f in FIXED_HINTS" :key="f.keys" class="fixed-item">
            <span class="kbd ghost">{{ f.keys }}</span>{{ f.label }}
          </span>
        </div>
        <button class="reset" :class="{ confirm: confirmReset }" :disabled="!changed" @click="onReset">
          <Icon name="undo" :size="12" />
          {{ confirmReset ? "确认恢复？" : "恢复默认" }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 全屏遮罩：面板从工具条里挪出来，因此可以真正居中（工具条带 translate，会吃掉 fixed） */
.kb-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: var(--mask);
  backdrop-filter: blur(2px);
  animation: veil-in 140ms var(--ease);
}

.kb-dialog {
  width: 480px;
  max-width: calc(100vw - 48px);
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  padding: 14px 16px 12px;
  background: rgba(252, 252, 253, 0.96);
  box-shadow:
    0 32px 80px rgba(0, 0, 0, 0.28),
    0 2px 8px rgba(0, 0, 0, 0.12);
  animation: dialog-in 160ms var(--ease);
}

@keyframes veil-in {
  from {
    opacity: 0;
  }
}

@keyframes dialog-in {
  from {
    opacity: 0;
    transform: scale(0.975) translateY(4px);
  }
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--hairline);
}

.titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}

.hint {
  font-size: 10.5px;
  color: var(--text-faint);
}

.close {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: none;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.close:hover {
  background: var(--tint-5);
  color: var(--text);
}

/* 两列：按分组顺序自然流动（左列满了接右列），分组不被拆开 */
.cols {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  columns: 2;
  column-gap: 20px;
  padding: 8px 2px 4px;
}

.group {
  padding: 2px 0 6px;
  break-inside: avoid;
}

.micro-label {
  display: block;
  padding: 3px 6px;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 27px;
  padding: 0 6px;
  border-radius: 7px;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}

.row:hover {
  background: var(--tint-4);
}

.row.recording {
  background: var(--accent-soft);
}

.label {
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row:hover .label,
.row.recording .label {
  color: var(--text);
}

.kbd {
  flex: none;
  min-width: 22px;
  text-align: center;
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid var(--hairline);
  background: var(--tint-3);
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 16px;
}

.kbd.custom {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

.recording-kbd {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--surface);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}

.error {
  margin: 6px 0 0;
  padding: 4px 8px;
  border-radius: 7px;
  background: rgba(220, 38, 38, 0.08);
  color: #b91c1c;
  font-size: 11px;
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--hairline);
  padding-top: 9px;
  margin-top: 6px;
}

.fixed {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 10px;
  min-width: 0;
}

.fixed-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--text-faint);
}

.kbd.ghost {
  border-style: dashed;
  background: transparent;
  font-size: 9.5px;
}

.reset {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex: none;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--hairline);
  border-radius: 7px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}

.reset:hover:not(:disabled) {
  background: var(--glass-strong);
  color: var(--text);
}

.reset.confirm {
  border-color: rgba(220, 38, 38, 0.4);
  color: #b91c1c;
  background: rgba(220, 38, 38, 0.06);
}

.reset:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
