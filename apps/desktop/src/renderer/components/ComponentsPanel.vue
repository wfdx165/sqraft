<script setup lang="ts">
/**
 * 组件面板：平铺列出全文档主组件（母版是文档根节点，不属于任何页面，ADR-0025）。
 * 组件集合按「集合 → 变体」两级展示（ADR-0038）。
 * 单击 = 选中并飞行定位（只看不动文档）；双击/行尾「+」= 插入实例。
 */
import { computed, ref } from "vue";
import { getRootComponents, type NodeId } from "@sqraft/core";
import { docStore, hooks, select, switchMode, ui } from "../store";
import { openNodeMenu } from "../object-menu";
import { variantSets, duplicateVariant } from "../variant-actions";
import { t } from "../i18n";
import Icon from "./Icon.vue";

const masters = computed<Array<{ id: NodeId; name: string }>>(() => {
  void ui.version;
  return getRootComponents(docStore.doc).map((n) => ({ id: n.id, name: n.name }));
});

const sets = computed(() => {
  void ui.version;
  return variantSets();
});

const total = computed(() => masters.value.length + sets.value.length);

const collapsed = ref<Record<NodeId, boolean>>({});

function isOpen(id: NodeId): boolean {
  return collapsed.value[id] !== true;
}

function toggle(id: NodeId): void {
  collapsed.value = { ...collapsed.value, [id]: isOpen(id) };
}

function insert(id: NodeId): void {
  hooks.insertInstance(id);
}

/**
 * 单击：选中并飞行定位。母版/集合不在页面里，所以只切编辑模式、不改活动页；
 * 选中框要画在画布上，pan 模式下先切回 edit。
 */
function goto(id: NodeId): void {
  switchMode("edit");
  select([id]);
  hooks.focusNode(id);
}

function menu(id: NodeId, e: MouseEvent): void {
  goto(id);
  openNodeMenu(id, { x: e.clientX, y: e.clientY });
}

/** 集合行尾「+」：复制最后一个变体并自动取一个新值。 */
function addVariant(setId: NodeId): void {
  const set = sets.value.find((entry) => entry.set.id === setId);
  const source = set?.variants.at(-1);
  if (!source) return;
  switchMode("edit");
  duplicateVariant(setId, source.id);
}
</script>

<template>
  <div class="panel" :data-version="ui.version">
    <header>
      <span class="micro-label">{{ t("panel.components") }}</span>
      <span class="count">{{ total }}</span>
    </header>

    <div v-if="!total" class="empty">
      <p>{{ t("components.emptyTitle") }}</p>
      <span>{{ t("components.emptyHint") }}</span>
    </div>

    <div v-for="entry in sets" :key="entry.set.id" class="group">
      <div class="item set-row">
        <button
          class="caret"
          :title="isOpen(entry.set.id) ? t('components.collapse') : t('components.expand')"
          @click="toggle(entry.set.id)"
        >
          <span :class="{ open: isOpen(entry.set.id) }">▸</span>
        </button>
        <button
          class="row-main"
          :title="t('components.setHint')"
          @click="goto(entry.set.id)"
          @contextmenu.prevent="menu(entry.set.id, $event)"
        >
          <Icon name="component" :size="14" />
          <span class="name">{{ entry.set.name }}</span>
          <span class="badge">{{ entry.variants.length }}</span>
        </button>
        <button class="insert" :title="t('components.addVariant')" @click="addVariant(entry.set.id)">
          <Icon name="plus" :size="12" />
        </button>
      </div>

      <template v-if="isOpen(entry.set.id)">
        <div v-for="variant in entry.variants" :key="variant.id" class="item variant-row">
          <button
            class="row-main"
            :title="t('components.variantHint')"
            @click="goto(variant.id)"
            @dblclick="insert(variant.id)"
            @contextmenu.prevent="menu(variant.id, $event)"
          >
            <span class="variant-dot" />
            <span class="name">{{ variant.name }}</span>
          </button>
          <button class="insert" :title="t('components.insert')" @click="insert(variant.id)">
            <Icon name="plus" :size="12" />
          </button>
        </div>
      </template>
    </div>

    <div v-for="c in masters" :key="c.id" class="item">
      <button
        class="row-main"
        :title="t('components.rowHint')"
        @click="goto(c.id)"
        @dblclick="insert(c.id)"
        @contextmenu.prevent="menu(c.id, $event)"
      >
        <Icon name="component" :size="14" />
        <span class="name">{{ c.name }}</span>
      </button>
      <button class="insert" :title="t('components.insert')" @click="insert(c.id)">
        <Icon name="plus" :size="12" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 8px 10px 14px;
  overflow: auto;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 8px;
}

.count {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-faint);
}

.empty {
  margin: 8px 4px;
  padding: 14px 12px;
  border: 1px dashed var(--hairline-strong);
  border-radius: var(--radius-md);
  color: var(--text-dim);
}

.empty p {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--text);
}

.empty span {
  font-size: 11px;
  line-height: 1.5;
}

.group {
  margin-bottom: 2px;
}

.item {
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
}

.item:hover {
  background: var(--glass-strong);
  border-color: var(--hairline);
}

.set-row .row-main {
  font-weight: 550;
}

.variant-row {
  padding-left: 18px;
}

.variant-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.6;
}

.badge {
  flex: none;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--glass-strong);
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 9.5px;
}

.caret {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 22px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-faint);
  font-size: 10px;
  cursor: pointer;
}

.caret span {
  display: inline-block;
  transition: transform 120ms ease;
}

.caret span.open {
  transform: rotate(90deg);
}

/* 行主体仍是按钮：键盘 Tab 得到焦点、Enter 触发 */
.row-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 4px 6px 8px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.row-main :deep(svg) {
  color: var(--accent);
  flex: none;
}

.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 行尾插入：默认极淡，悬停整行才显出来，避免和"单击定位"抢注意力 */
.insert {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  margin-right: 6px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  opacity: 0;
  cursor: pointer;
  transition: opacity 120ms ease, background 120ms ease;
}

.item:hover .insert,
.insert:focus-visible {
  opacity: 1;
}

.insert:hover {
  background: var(--glass-strong);
  border-color: var(--hairline);
  color: var(--accent);
}
</style>
