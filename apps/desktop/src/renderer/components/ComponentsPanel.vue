<script setup lang="ts">
/**
 * 组件面板：按页面分组列出全文档主组件。
 * 单击在活动页视口中心插入实例；双击跳转到主组件。
 */
import { computed, onBeforeUnmount } from "vue";
import type { NodeId } from "@sqraft/core";
import { docStore, hooks, ui } from "../store";
import Icon from "./Icon.vue";

interface Group {
  pageId: NodeId;
  pageName: string;
  components: Array<{ id: NodeId; name: string }>;
}

const groups = computed<Group[]>(() => {
  void ui.version;
  const out: Group[] = [];
  for (const pid of docStore.doc.rootIds) {
    const page = docStore.doc.nodes[pid];
    if (!page) continue;
    const components = page.children
      .map((id) => docStore.doc.nodes[id])
      .filter((n) => n?.type === "component")
      .map((n) => ({ id: n!.id, name: n!.name }));
    if (components.length) out.push({ pageId: pid, pageName: page.name, components });
  }
  return out;
});

const total = computed(() => {
  void ui.version;
  return Object.values(docStore.doc.nodes).filter((n) => n.type === "component").length;
});

function insert(id: NodeId): void {
  hooks.insertInstance(id);
}

/** 双击跳主组件：先把活动页切到主组件所在页，再飞行定位。 */
function goto(masterId: NodeId): void {
  let cur = docStore.doc.nodes[masterId];
  while (cur && cur.type !== "page") {
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  if (cur) {
    ui.activePageId = cur.id;
    ui.expandedPageId = cur.id;
  }
  hooks.focusNode(masterId);
}

/** 单击插入、双击跳转：用计时器区分，避免双击时插入两个实例。 */
let clickTimer = 0;
function onClick(id: NodeId): void {
  window.clearTimeout(clickTimer);
  clickTimer = window.setTimeout(() => insert(id), 220);
}
function onDblClick(id: NodeId): void {
  window.clearTimeout(clickTimer);
  goto(id);
}
onBeforeUnmount(() => window.clearTimeout(clickTimer));
</script>

<template>
  <div class="panel" :data-version="ui.version">
    <header>
      <span class="micro-label">组件</span>
      <span class="count">{{ total }}</span>
    </header>

    <div v-if="!total" class="empty">
      <p>还没有主组件</p>
      <span>选中页面顶层的画板或分组，按 ⌥⌘K 创建</span>
    </div>

    <div v-for="g in groups" :key="g.pageId" class="group">
      <div class="group-label">{{ g.pageName }}</div>
      <button
        v-for="c in g.components"
        :key="c.id"
        class="item"
        :title="`单击插入实例，双击跳转主组件`"
        @click="onClick(c.id)"
        @dblclick="onDblClick(c.id)"
      >
        <Icon name="component" :size="14" />
        <span class="name">{{ c.name }}</span>
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
  margin-top: 6px;
}

.group-label {
  padding: 4px 4px 3px;
  font-size: 10.5px;
  color: var(--text-faint);
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.item:hover {
  background: var(--glass-strong);
  border-color: var(--hairline);
}

.item :deep(svg) {
  color: var(--accent);
  flex: none;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
