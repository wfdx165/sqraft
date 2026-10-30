<script setup lang="ts">
/**
 * 组件面板：平铺列出全文档主组件（母版是文档根节点，不属于任何页面，ADR-0025）。
 * 单击 = 选中母版并飞行定位（只看不动文档）；双击 = 插入实例；行尾「+」也插入。
 */
import { computed } from "vue";
import { getRootComponents, type NodeId } from "@sqraft/core";
import { docStore, hooks, select, switchMode, ui } from "../store";
import Icon from "./Icon.vue";

const masters = computed<Array<{ id: NodeId; name: string }>>(() => {
  void ui.version;
  return getRootComponents(docStore.doc).map((n) => ({ id: n.id, name: n.name }));
});

const total = computed(() => masters.value.length);

function insert(id: NodeId): void {
  hooks.insertInstance(id);
}

/**
 * 单击：选中母版并飞行定位。母版不在页面里，所以只切编辑模式、不改活动页；
 * 选中框要画在画布上，pan 模式下先切回 edit。
 */
function goto(masterId: NodeId): void {
  switchMode("edit");
  select([masterId]);
  hooks.focusNode(masterId);
}
</script>

<template>
  <div class="panel" :data-version="ui.version">
    <header>
      <span class="micro-label">组件</span>
      <span class="count">{{ total }}</span>
    </header>

    <div v-if="!total" class="empty">
      <p>还没有主组件</p>
      <span>选中画板或分组，按 ⌥⌘K 创建</span>
    </div>

    <div v-for="c in masters" :key="c.id" class="item">
      <button
        class="row-main"
        :title="`单击定位母版，双击插入实例`"
        @click="goto(c.id)"
        @dblclick="insert(c.id)"
      >
        <Icon name="component" :size="14" />
        <span class="name">{{ c.name }}</span>
      </button>
      <button class="insert" title="插入实例" @click="insert(c.id)">
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
