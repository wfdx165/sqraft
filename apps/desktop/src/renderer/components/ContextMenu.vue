<script setup lang="ts">
/** 自绘右键菜单：贴边翻转、Esc/点外部关闭、↑↓ 选择、Enter 执行。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { closeContextMenu, contextMenu } from "../context-menu";
import Icon from "./Icon.vue";

const el = ref<HTMLDivElement | null>(null);
const left = ref(0);
const top = ref(0);
const active = ref(-1);

const enabled = computed(() =>
  contextMenu.items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0),
);

/** 贴边翻转：右下角放不下就翻到指针左/上方，再兜底夹进窗口。 */
function place(): void {
  const node = el.value;
  if (!node) return;
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const margin = 8;
  let x = contextMenu.x;
  let y = contextMenu.y;
  if (x + width > window.innerWidth - margin) x = Math.max(margin, x - width);
  if (y + height > window.innerHeight - margin) y = Math.max(margin, y - height);
  left.value = x;
  top.value = y;
}

function run(index: number): void {
  const item = contextMenu.items[index];
  if (!item || item.disabled) return;
  closeContextMenu();
  item.run();
}

function move(step: number): void {
  if (enabled.value.length === 0) return;
  const at = enabled.value.indexOf(active.value);
  const nextAt = at < 0 ? (step > 0 ? 0 : enabled.value.length - 1) : (at + step + enabled.value.length) % enabled.value.length;
  active.value = enabled.value[nextAt];
}

function onKey(e: KeyboardEvent): void {
  if (!contextMenu.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeContextMenu();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    move(e.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (e.key === "Enter" && active.value >= 0) {
    e.preventDefault();
    run(active.value);
  }
}

/** 点菜单外部就关；菜单内部的按下不关（否则项还没 click 就被关掉）。 */
function onPointerDown(e: PointerEvent): void {
  if (!contextMenu.open) return;
  if (el.value?.contains(e.target as Node)) return;
  closeContextMenu();
}

watch(
  () => contextMenu.open,
  async (open) => {
    if (!open) {
      active.value = -1;
      return;
    }
    active.value = -1;
    await nextTick();
    place();
  },
);

onMounted(() => {
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeContextMenu);
  window.addEventListener("resize", closeContextMenu);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", closeContextMenu);
  window.removeEventListener("resize", closeContextMenu);
});
</script>

<template>
  <div
    v-if="contextMenu.open"
    ref="el"
    class="context-menu glass"
    role="menu"
    :style="{ left: left + 'px', top: top + 'px' }"
  >
    <template v-for="(item, index) in contextMenu.items" :key="index">
      <div v-if="item.separator && index > 0" class="sep" role="separator" />
      <button
        class="item"
        role="menuitem"
        :class="{ danger: item.danger, active: active === index }"
        :disabled="item.disabled"
        @pointerenter="active = item.disabled ? -1 : index"
        @click="run(index)"
      >
        <Icon v-if="item.icon" :name="item.icon" :size="12" class="item-icon" />
        <span class="label">{{ item.label }}</span>
        <span v-if="item.hint" class="hint">{{ item.hint }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 60;
  min-width: 196px;
  padding: 4px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hairline-strong);
  background: var(--surface);
  box-shadow: var(--shadow-float);
  display: flex;
  flex-direction: column;
  gap: 1px;
  user-select: none;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.item.active:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}

.item:disabled {
  color: var(--text-faint);
  cursor: default;
  opacity: 0.55;
}

.item.danger:not(:disabled) {
  color: var(--danger);
}

.item-icon {
  flex: none;
  color: currentColor;
}

.label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hint {
  flex: none;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-faint);
}

.item.active:not(:disabled) .hint {
  color: inherit;
  opacity: 0.8;
}

.sep {
  height: 1px;
  margin: 3px 6px;
  background: var(--hairline);
}
</style>
