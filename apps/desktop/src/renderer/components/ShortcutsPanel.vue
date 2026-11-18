<script setup lang="ts">
/**
 * 快捷键分类：由设置外壳承载，自身只负责列表、录制与冲突提示。
 * 点击键位就地录制；Esc 或右上角 × 关闭设置；冲突/保留键当场拒绝。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ACTIONS,
  FIXED_HINTS,
  GROUP_ORDER,
  bindingOfEvent,
  formatBinding,
  isDefault,
  keyLabel,
  resetAll,
  setBinding,
  shortcutUi,
  validateBinding,
  type ActionGroup,
} from "../shortcuts";
import { t } from "../i18n";
import { closeSettings, settingsUi } from "../settings";
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
  closeSettings();
  stopRecord();
}

/** 切到别的分类时不能把录制态带过去，否则键盘会被这一栏继续吃掉。 */
watch(
  () => settingsUi.section,
  () => stopRecord(),
);

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
  // 四个分类常驻（v-show），切走后这一栏的录制/关闭逻辑不能继续吃按键
  if (settingsUi.section !== "shortcuts") return;
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
  // 关闭设置（外壳 v-if 卸载）时录制态必须复位，否则重开后捕获监听会继续吞按键
  stopRecord();
});
</script>

<template>
  <div class="kb-embedded">
    <div class="kb-dialog" role="group" :aria-label="t('shortcuts.title')">
      <header class="head">
        <div class="titles">
          <span class="title">{{ t("shortcuts.title") }}</span>
          <span class="hint">{{ shortcutUi.recording ? t("shortcuts.recordHint") : t("shortcuts.editHint") }}</span>
        </div>
      </header>

      <div class="cols">
        <section v-for="g in groups" :key="g.group" class="group">
          <span class="micro-label">{{ t(`shortcut.group.${g.group}`) }}</span>
          <div
            v-for="a in g.items"
            :key="a.id"
            class="row"
            :class="{ recording: shortcutUi.recording === a.id }"
            @click="startRecord(a.id)"
          >
            <span class="label">{{ t(a.labelKey) }}</span>
            <span v-if="shortcutUi.recording === a.id" class="kbd recording-kbd">{{ t("shortcuts.press") }}</span>
            <span v-else class="kbd" :class="{ custom: !isDefault(a.id) }">{{ keyLabel(a.id) }}</span>
          </div>
        </section>
      </div>

      <p v-if="shortcutUi.error" class="error">{{ shortcutUi.error }}</p>

      <footer class="foot">
        <div class="fixed">
          <span v-for="f in FIXED_HINTS" :key="f.keys" class="fixed-item">
            <span class="kbd ghost">{{ formatBinding(f.keys) }}</span>{{ t(f.labelKey) }}
          </span>
        </div>
        <button class="reset" :class="{ confirm: confirmReset }" :disabled="!changed" @click="onReset">
          <Icon name="undo" :size="12" />
          {{ confirmReset ? t("shortcuts.confirmReset") : t("shortcuts.resetDefault") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 设置外壳已经给了遮罩与滚动容器，这里只铺满分类内容区 */
.kb-embedded {
  height: 100%;
  display: flex;
}

.kb-dialog {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0;
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
