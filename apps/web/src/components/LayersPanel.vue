<script setup lang="ts">
import { computed } from "vue";
import type { DocNode, NodeId } from "@sqraft/core";
import { currentPageId, dispatch, docStore, select, ui } from "../store";

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

const typeLabel: Record<string, string> = {
  frame: "画板", rect: "矩形", ellipse: "椭圆", line: "直线", text: "文本",
  group: "分组", component: "组件", instance: "实例",
};
</script>

<template>
  <div class="panel">
    <h3>图层</h3>
    <div v-if="rows.length === 0" class="empty">画布为空，用工具栏画点什么</div>
    <div
      v-for="row in rows"
      :key="row.node.id"
      class="row"
      :class="{ selected: ui.selection.includes(row.node.id) }"
      :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }"
      @click="onClick(row, $event)"
    >
      <span class="type">{{ typeLabel[row.node.type] ?? row.node.type }}</span>
      <span class="name">{{ row.node.name }}</span>
      <button class="del" title="删除" @click.stop="onDelete(row.node.id)">×</button>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 8px 0; }
h3 { font-size: 12px; margin: 0 0 6px 10px; color: #666; font-weight: 600; }
.empty { padding: 10px; font-size: 12px; color: #999; }
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  font-size: 12px;
  cursor: pointer;
  border-radius: 0;
}
.row:hover { background: #f0f0f3; }
.row.selected { background: #e8eeff; }
.type { color: #888; font-size: 10px; min-width: 26px; }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.del { visibility: none; border: none; background: none; color: #aaa; cursor: pointer; font-size: 12px; }
.row:hover .del { visibility: visible; color: #d33; }
</style>
