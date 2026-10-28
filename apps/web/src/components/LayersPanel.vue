<script setup lang="ts">
import { computed } from "vue";
import type { DocNode, NodeId } from "@sqraft/core";
import { currentPageId, dispatch, docStore, select, ui } from "../store";
import Icon from "./Icon.vue";

interface Row {
  node: DocNode;
  depth: number;
}

const rows = computed<Row[]>(() => {
  void ui.version;
  const pageId = currentPageId();
  if (!pageId) return [];
  const out: Row[] = [];
  const visit = (id: NodeId, depth: number) => {
    const node = docStore.doc.nodes[id];
    if (!node) return;
    if (node.type !== "page") out.push({ node, depth });
    for (const c of node.children) visit(c, depth + 1);
  };
  for (const c of docStore.doc.nodes[pageId].children) visit(c, 0);
  return out;
});

const iconOf: Record<string, string> = {
  frame: "frame",
  rect: "rect",
  ellipse: "ellipse",
  line: "line",
  text: "text",
  group: "group",
  component: "rect",
  instance: "rect",
};

function onClick(row: Row, e: MouseEvent) {
  if (e.shiftKey) {
    const set = new Set(ui.selection);
    set.has(row.node.id) ? set.delete(row.node.id) : set.add(row.node.id);
    select([...set]);
  } else {
    select([row.node.id]);
  }
}

function onDelete(id: NodeId) {
  dispatch({ type: "node.delete", params: { nodeId: id } }, "delete");
  select(ui.selection.filter((s) => s !== id));
}
</script>

<template>
  <div class="panel">
    <header>
      <span class="micro-label">图层</span>
      <span class="count">{{ rows.length }}</span>
    </header>
    <div v-if="rows.length === 0" class="empty">
      <Icon name="rect" :size="22" />
      <p>画布为空</p>
      <span>用工具栏画点什么，或让 AI 生成</span>
    </div>
    <div
      v-for="row in rows"
      :key="row.node.id"
      class="row"
      :class="{ selected: ui.selection.includes(row.node.id) }"
      :style="{ paddingLeft: 6 + row.depth * 12 + 'px' }"
      @click="onClick(row, $event)"
    >
      <Icon class="type" :name="iconOf[row.node.type] ?? 'rect'" :size="14" />
      <span class="name">{{ row.node.name }}</span>
      <button class="act" title="删除" @click.stop="onDelete(row.node.id)"><Icon name="close" :size="12" /></button>
    </div>
  </div>
</template>

<style scoped>
.panel {
  padding: 12px 6px 10px;
  height: 100%;
  box-sizing: border-box;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 10px;
}

.count {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-faint);
  background: var(--glass-strong);
  border-radius: var(--radius-pill);
  padding: 1px 7px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding-right: 6px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-dim);
  cursor: default;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.row:hover {
  background: var(--glass-strong);
  color: var(--text);
}

.row.selected {
  background: var(--accent-soft);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--accent);
}

.type {
  flex: none;
  color: var(--text-faint);
}

.row.selected .type {
  color: var(--accent);
}

.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.act {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.row:hover .act {
  opacity: 1;
}

.act:hover {
  color: var(--danger);
  background: rgba(242, 109, 109, 0.1);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 44px 16px;
  color: var(--text-faint);
  text-align: center;
}

.empty p {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--text-dim);
}

.empty span {
  font-size: 11px;
  line-height: 1.6;
}
</style>
