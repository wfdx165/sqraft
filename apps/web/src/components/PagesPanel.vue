<script setup lang="ts">
import { computed, ref } from "vue";
import { createNode, getPages, nextPageName, type DocNode, type NodeId } from "@sqraft/core";
import { currentPageId, dispatch, docStore, hooks, select, ui } from "../store";
import Icon from "./Icon.vue";

interface Row {
  node: DocNode;
  depth: number;
}

const pages = computed(() => {
  void ui.version;
  return getPages(docStore.doc);
});

const activePage = computed(() => {
  void ui.version;
  return currentPageId();
});

/** 当前页面下的图层树（手风琴：仅展开活动页面） */
const rows = computed<Row[]>(() => {
  void ui.version;
  const pageId = activePage.value;
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

const layerCount = (page: DocNode) => page.children.length;

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

/* ---------- 页面操作 ---------- */

function switchPage(id: NodeId) {
  if (ui.activePageId === id) return;
  ui.activePageId = id;
  select([]);
  hooks.requestRedraw();
}

const renamingId = ref<NodeId | null>(null);
const draftName = ref("");

function startRename(page: DocNode) {
  renamingId.value = page.id;
  draftName.value = page.name;
}

function commitRename() {
  const id = renamingId.value;
  if (!id) return;
  const name = draftName.value.trim();
  if (name) dispatch({ type: "node.update", params: { nodeId: id, patch: { name } } }, "rename-page");
  renamingId.value = null;
}

function cancelRename() {
  renamingId.value = null;
}

function addPage() {
  const node = createNode("page", { name: nextPageName(docStore.doc) });
  dispatch({ type: "node.create", params: { nodes: [node], parentId: null } }, "create-page");
  ui.activePageId = node.id;
  select([]);
  hooks.requestRedraw();
}

function deletePage(page: DocNode) {
  if (pages.value.length <= 1) return;
  if (!window.confirm(`删除页面「${page.name}」及其全部图层？`)) return;
  dispatch({ type: "node.delete", params: { nodeId: page.id } }, "delete-page");
  if (ui.activePageId === page.id) ui.activePageId = currentPageId();
  hooks.requestRedraw();
}

/* ---------- 图层操作 ---------- */

function onLayerClick(row: Row, e: MouseEvent) {
  if (e.shiftKey) {
    const set = new Set(ui.selection);
    set.has(row.node.id) ? set.delete(row.node.id) : set.add(row.node.id);
    select([...set]);
    hooks.requestRedraw();
  } else {
    select([row.node.id]);
    hooks.focusNode(row.node.id); // 选中 + 定位 + 脉冲标记
  }
}

function onLayerDelete(id: NodeId) {
  dispatch({ type: "node.delete", params: { nodeId: id } }, "delete");
  select(ui.selection.filter((s) => s !== id));
}
</script>

<template>
  <div class="panel">
    <header>
      <span class="micro-label">页面</span>
      <button class="add" title="新建页面" @click="addPage"><Icon name="plus" :size="13" /></button>
    </header>

    <div class="pages">
      <div v-for="page in pages" :key="page.id" class="page-block">
        <div
          class="page-row"
          :class="{ active: activePage === page.id }"
          @click="switchPage(page.id)"
        >
          <Icon name="chevron" :size="12" class="caret" :class="{ open: activePage === page.id }" />
          <input
            v-if="renamingId === page.id"
            v-model="draftName"
            class="rename"
            autofocus
            @click.stop
            @blur="commitRename"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
          />
          <span v-else class="page-name" title="双击重命名" @dblclick.stop="startRename(page)">{{ page.name }}</span>
          <span class="count">{{ layerCount(page) }}</span>
          <button
            v-if="pages.length > 1"
            class="act"
            title="删除页面"
            @click.stop="deletePage(page)"
          >
            <Icon name="close" :size="11" />
          </button>
        </div>

        <!-- 手风琴：仅活动页面展开图层 -->
        <div v-if="activePage === page.id" class="layers">
          <div v-if="rows.length === 0" class="empty-layer">暂无图层</div>
          <div
            v-for="row in rows"
            :key="row.node.id"
            class="row"
            :class="{ selected: ui.selection.includes(row.node.id) }"
            :style="{ paddingLeft: 24 + row.depth * 12 + 'px' }"
            @click="onLayerClick(row, $event)"
          >
            <Icon class="type" :name="iconOf[row.node.type] ?? 'rect'" :size="13" />
            <span class="name">{{ row.node.name }}</span>
            <button class="act" title="删除" @click.stop="onLayerDelete(row.node.id)"><Icon name="close" :size="11" /></button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel {
  padding: 12px 6px 10px;
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 8px;
}

.add {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--hairline);
  border-radius: 7px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.add:hover {
  background: var(--glass-strong);
  color: var(--text);
}

.page-block {
  margin-bottom: 2px;
}

.page-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px 0 6px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  cursor: default;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.page-row:hover {
  background: var(--glass-strong);
  color: var(--text);
}

.page-row.active {
  color: var(--text);
  background: rgba(255, 255, 255, 0.045);
}

.caret {
  flex: none;
  color: var(--text-faint);
  transform: rotate(-90deg);
  transition: transform var(--dur-fast) var(--ease);
}

.caret.open {
  transform: rotate(0deg);
}

.page-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 500;
}

.rename {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--accent-line);
  border-radius: 6px;
  color: var(--text);
  font-size: 12.5px;
  font-family: inherit;
  padding: 2px 6px;
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.count {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--text-faint);
}

.layers {
  padding: 2px 0 6px;
}

.empty-layer {
  padding: 4px 0 4px 26px;
  font-size: 11px;
  color: var(--text-faint);
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
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
  transition:
    opacity var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.page-row:hover .act,
.row:hover .act {
  opacity: 1;
}

.act:hover {
  color: var(--danger);
  background: rgba(242, 109, 109, 0.1);
}
</style>
