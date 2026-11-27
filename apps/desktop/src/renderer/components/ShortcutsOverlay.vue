<script setup lang="ts">
/**
 * `?` 速查浮层（R19）：与设置里的快捷键面板同源，只列当前上下文可用的项。
 *
 * 上下文：演示中只列演示入口；`requires: "doc"` 的项在没有文档时隐藏；
 * `requires: "selection"` 的项在没有选区时隐藏。Esc 或点遮罩关闭。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ACTIONS, keyOf } from "../shortcuts";
import { settingsUi } from "../settings";
import { ui } from "../store";
import { t } from "../i18n";

const open = ref(false);

function available(requires: "always" | "doc" | "selection" | undefined): boolean {
  if (ui.presenter) return false;
  if (requires === "doc") return ui.docOpen;
  if (requires === "selection") return ui.selection.length > 0;
  return true;
}

const items = computed(() => {
  if (ui.presenter) {
    const present = ACTIONS.find((action) => action.id === "view.present");
    return present ? [{ id: present.id, label: t(present.labelKey), keys: keyOf(present.id) }] : [];
  }
  return ACTIONS.filter((action) => keyOf(action.id) && available(action.requires)).map((action) => ({
    id: action.id,
    label: t(action.labelKey),
    keys: keyOf(action.id),
  }));
});

function onKeyDown(e: KeyboardEvent): void {
  if (open.value && e.key === "Escape") {
    e.preventDefault();
    open.value = false;
    return;
  }
  if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (settingsUi.open) return;
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
  e.preventDefault();
  open.value = true;
}

onMounted(() => window.addEventListener("keydown", onKeyDown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeyDown));
</script>

<template>
  <div v-if="open" class="mask" @pointerdown.self="open = false">
    <section class="card glass">
      <header>
        <span class="title">{{ t("shortcuts.overlayTitle") }}</span>
        <span class="hint">{{ t("shortcuts.overlayHint") }}</span>
      </header>
      <div class="grid">
        <div v-for="item in items" :key="item.id" class="row">
          <span class="label">{{ item.label }}</span>
          <kbd>{{ item.keys }}</kbd>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  background: var(--mask);
  backdrop-filter: blur(2px);
}

.card {
  width: min(720px, calc(100vw - 64px));
  max-height: min(70vh, 640px);
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  border: 1px solid var(--hairline);
  padding: 14px 16px 16px;
  box-shadow: var(--shadow-float);
  overflow: hidden;
}

header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--hairline);
}

.title {
  font-size: 13px;
  font-weight: 600;
}

.hint {
  font-size: 11px;
  color: var(--text-faint);
}

.grid {
  margin-top: 10px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 22px;
  overflow: auto;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 24px;
  font-size: 12px;
  color: var(--text-dim);
}

.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

kbd {
  flex: none;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text);
  background: var(--tint-4);
  border: 1px solid var(--hairline);
  border-radius: 5px;
  padding: 1px 5px;
}

@media (max-width: 620px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
