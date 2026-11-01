<script setup lang="ts">
/**
 * 数值 Token 选择器的浮层：搜索 + 列表 + 解绑。
 * 只列 `type === "number"` 的 Token；颜色 Token 走填充/描边的下拉。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { tokenNumberOf } from "@sqraft/core";
import { closeTokenPicker, pickToken, tokenPicker } from "../token-picker";
import { docStore, ui } from "../store";

const el = ref<HTMLDivElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const query = ref("");
const left = ref(0);
const top = ref(0);
const active = ref(0);

const numberTokens = computed(() => {
  void ui.version;
  return Object.entries(docStore.doc.tokens)
    .filter(([, entry]) => entry.type === "number")
    .map(([path, entry]) => ({ path, value: tokenNumberOf(entry.value) ?? 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
});

const visible = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return numberTokens.value;
  return numberTokens.value.filter((token) => token.path.toLowerCase().includes(q));
});

interface Option {
  path: string | null;
  label: string;
  value: string;
}

/** 列表项 = 可选的「解绑」+ 可见的数值 Token。 */
const options = computed<Option[]>(() => {
  const list: Option[] = visible.value.map((token) => ({
    path: token.path,
    label: token.path,
    value: String(token.value),
  }));
  if (tokenPicker.current) list.unshift({ path: null, label: "解绑", value: "恢复字面量" });
  return list;
});

/** 过滤后列表变化：默认高亮第一个可选项（有绑定时优先当前 Token）。 */
watch(visible, () => {
  active.value = visible.value.length > 0 && tokenPicker.current ? 1 : 0;
});

/** 贴边翻转：右下角放不下就翻到指针左/上方，再夹进窗口。 */
function place(): void {
  const node = el.value;
  if (!node) return;
  const margin = 8;
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  let x = tokenPicker.x;
  let y = tokenPicker.y;
  if (x + width > window.innerWidth - margin) x = Math.max(margin, x - width);
  if (y + height > window.innerHeight - margin) y = Math.max(margin, y - height);
  left.value = x;
  top.value = y;
}

function move(step: number): void {
  if (options.value.length === 0) return;
  active.value = (active.value + step + options.value.length) % options.value.length;
  void nextTick(() => {
    el.value?.querySelector<HTMLElement>(`[data-index="${active.value}"]`)?.scrollIntoView({ block: "nearest" });
  });
}

function choose(index = active.value): void {
  const option = options.value[index];
  if (!option) return;
  pickToken(option.path);
}

function onKey(e: KeyboardEvent): void {
  if (!tokenPicker.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeTokenPicker();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    move(e.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    choose();
  }
}

/** 点浮层外部就关；内部按下不关（否则点不中条目）。 */
function onPointerDown(e: PointerEvent): void {
  if (!tokenPicker.open) return;
  if (el.value?.contains(e.target as Node)) return;
  closeTokenPicker();
}

watch(
  () => tokenPicker.open,
  async (open) => {
    if (!open) return;
    query.value = "";
    const found = visible.value.findIndex((token) => token.path === tokenPicker.current);
    active.value = found >= 0 ? found + 1 : visible.value.length > 0 && tokenPicker.current ? 1 : 0;
    await nextTick();
    place();
    searchEl.value?.focus();
  },
);

onMounted(() => {
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeTokenPicker);
  window.addEventListener("resize", closeTokenPicker);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", closeTokenPicker);
  window.removeEventListener("resize", closeTokenPicker);
});
</script>

<template>
  <div
    v-if="tokenPicker.open"
    ref="el"
    class="token-picker glass"
    role="dialog"
    aria-label="绑定数值 Token"
    :style="{ left: left + 'px', top: top + 'px' }"
  >
    <input
      ref="searchEl"
      v-model="query"
      class="search"
      placeholder="搜索数值 Token…"
      spellcheck="false"
      @keydown.esc.prevent="closeTokenPicker"
    />
    <div class="list">
      <button
        v-for="(option, index) in options"
        :key="option.path ?? '__detach__'"
        class="row"
        :class="{ on: option.path !== null && option.path === tokenPicker.current, active: index === active }"
        :data-index="index"
        @mouseenter="active = index"
        @click="choose(index)"
      >
        <span class="path" :class="{ detach: option.path === null }">{{ option.label }}</span>
        <span class="value">{{ option.value }}</span>
      </button>
      <p v-if="visible.length === 0" class="empty">
        {{ numberTokens.length === 0 ? "还没有数值 Token，可在设计系统面板新建" : "没有匹配的数值 Token" }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.token-picker {
  position: fixed;
  z-index: 65;
  width: 248px;
  padding: 6px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hairline-strong);
  background: var(--surface);
  box-shadow: var(--shadow-float);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.search {
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}
.search:focus {
  border-color: var(--accent-line);
}

.list {
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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
.row:hover {
  background: var(--tint-4);
}
.row.on,
.row.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.path.detach {
  color: var(--text-dim);
}
.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.value {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.row.on .value,
.row.active .value {
  color: var(--accent);
}
.empty {
  margin: 0;
  padding: 10px 8px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
}
</style>
