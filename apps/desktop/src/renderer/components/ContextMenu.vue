<script setup lang="ts">
/** 自绘右键菜单：贴边翻转、Esc/点外部关闭、↑↓ 选择、Enter 执行；支持一级飞出子菜单。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { closeContextMenu, contextMenu, type ContextMenuItem } from "../context-menu";
import Icon from "./Icon.vue";

const el = ref<HTMLDivElement | null>(null);
const flyoutEl = ref<HTMLDivElement | null>(null);
const left = ref(0);
const top = ref(0);
const active = ref(-1);
/** 展开着的子菜单所属的父项下标；-1 = 没有 */
const openAt = ref(-1);
const flyout = ref<ContextMenuItem[]>([]);
const flyoutLeft = ref(0);
const flyoutTop = ref(0);
const flyoutActive = ref(-1);

const flyoutEnabled = computed(() =>
  flyout.value.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0),
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

async function placeFlyout(trigger: HTMLElement): Promise<void> {
  await nextTick();
  const node = flyoutEl.value;
  const rect = trigger.getBoundingClientRect();
  const margin = 8;
  let x = rect.right - 2;
  let y = rect.top - 4;
  if (node) {
    if (x + node.offsetWidth > window.innerWidth - margin) x = Math.max(margin, rect.left - node.offsetWidth + 2);
    if (y + node.offsetHeight > window.innerHeight - margin) {
      y = Math.max(margin, window.innerHeight - margin - node.offsetHeight);
    }
  }
  flyoutLeft.value = x;
  flyoutTop.value = y;
}

function closeFlyout(): void {
  openAt.value = -1;
  flyout.value = [];
  flyoutActive.value = -1;
}

function run(index: number): void {
  const item = contextMenu.items[index];
  if (!item || item.disabled) return;
  if (item.children?.length) {
    openAt.value = index;
    flyout.value = item.children;
    flyoutActive.value = -1;
    const trigger = el.value?.querySelectorAll<HTMLElement>(".item")[index];
    if (trigger) void placeFlyout(trigger);
    return;
  }
  closeContextMenu();
  item.run?.();
}

function runChild(index: number): void {
  const item = flyout.value[index];
  if (!item || item.disabled) return;
  closeContextMenu();
  item.run?.();
}

function hover(index: number, event: PointerEvent): void {
  active.value = contextMenu.items[index]?.disabled ? -1 : index;
  const item = contextMenu.items[index];
  if (!item?.children?.length) {
    if (openAt.value !== -1) closeFlyout();
    return;
  }
  openAt.value = index;
  flyout.value = item.children;
  flyoutActive.value = -1;
  void placeFlyout(event.currentTarget as HTMLElement);
}

function move(step: number, list: ContextMenuItem[], current: typeof active): void {
  const usable = list
    .map((item, index) => (item.disabled ? -1 : index))
    .filter((index) => index >= 0);
  if (usable.length === 0) return;
  const at = usable.indexOf(current.value);
  const next = at < 0 ? (step > 0 ? 0 : usable.length - 1) : (at + step + usable.length) % usable.length;
  current.value = usable[next];
}

function onKey(e: KeyboardEvent): void {
  if (!contextMenu.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    if (openAt.value !== -1) closeFlyout();
    else closeContextMenu();
    return;
  }
  if (e.key === "ArrowRight" && openAt.value === -1 && active.value >= 0) {
    const item = contextMenu.items[active.value];
    if (item?.children?.length) {
      e.preventDefault();
      run(active.value);
      flyoutActive.value = flyoutEnabled.value[0] ?? -1;
    }
    return;
  }
  if (e.key === "ArrowLeft" && openAt.value !== -1) {
    e.preventDefault();
    closeFlyout();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (openAt.value !== -1) move(e.key === "ArrowDown" ? 1 : -1, flyout.value, flyoutActive);
    else move(e.key === "ArrowDown" ? 1 : -1, contextMenu.items, active);
    return;
  }
  if (e.key === "Enter") {
    if (openAt.value !== -1 && flyoutActive.value >= 0) {
      e.preventDefault();
      runChild(flyoutActive.value);
    } else if (active.value >= 0) {
      e.preventDefault();
      run(active.value);
    }
  }
}

/** 点菜单外部就关；菜单内部的按下不关（否则项还没 click 就被关掉）。 */
function onPointerDown(e: PointerEvent): void {
  if (!contextMenu.open) return;
  const target = e.target as Node;
  if (el.value?.contains(target) || flyoutEl.value?.contains(target)) return;
  closeContextMenu();
}

watch(
  () => contextMenu.open,
  async (open) => {
    if (!open) {
      active.value = -1;
      closeFlyout();
      return;
    }
    active.value = -1;
    closeFlyout();
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
        :aria-haspopup="item.children?.length ? 'menu' : undefined"
        :aria-expanded="item.children?.length ? openAt === index : undefined"
        @pointerenter="hover(index, $event)"
        @click="run(index)"
      >
        <Icon v-if="item.icon" :name="item.icon" :size="12" class="item-icon" />
        <span class="label">{{ item.label }}</span>
        <span v-if="item.children?.length" class="arrow">›</span>
        <span v-else-if="item.hint" class="hint">{{ item.hint }}</span>
      </button>
    </template>
  </div>

  <div
    v-if="contextMenu.open && openAt !== -1"
    ref="flyoutEl"
    class="context-menu glass"
    role="menu"
    :style="{ left: flyoutLeft + 'px', top: flyoutTop + 'px' }"
  >
    <template v-for="(item, index) in flyout" :key="index">
      <div v-if="item.separator && index > 0" class="sep" role="separator" />
      <button
        class="item"
        role="menuitem"
        :class="{ danger: item.danger, active: flyoutActive === index }"
        :disabled="item.disabled"
        @pointerenter="flyoutActive = item.disabled ? -1 : index"
        @click="runChild(index)"
      >
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

.arrow {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 14px;
  line-height: 1;
}
</style>
