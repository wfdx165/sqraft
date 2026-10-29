<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  createNode,
  getPages,
  nextPageName,
  nextPagePosition,
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  type DocNode,
  type NodeId,
} from "@sqraft/core";
import { dispatch, docStore, hooks, select, ui } from "../store";
import Icon from "./Icon.vue";

interface Row {
  node: DocNode;
  depth: number;
}

const pages = computed(() => {
  void ui.version;
  return getPages(docStore.doc);
});

/** 当前页面下的图层树（手风琴：仅展开活动页面） */
const rows = computed<Row[]>(() => {
  void ui.version;
  const pageId = ui.expandedPageId;
  if (!pageId || !docStore.doc.nodes[pageId]) return [];
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
  triangle: "triangle",
  polygon: "triangle",
  line: "line",
  path: "pen",
  text: "text",
  group: "group",
  component: "rect",
  instance: "rect",
};

/* ---------- 页面操作 ---------- */

function togglePage(id: NodeId) {
  // 编辑模式：点左栏页面 = 切换活动页 + 适配该页（与画布活动页保持同步）
  if (ui.mode === "edit") {
    ui.activePageId = id;
    ui.expandedPageId = id;
    select([]);
    hooks.focusPage(id);
    return;
  }
  if (ui.expandedPageId === id) {
    ui.expandedPageId = null;
    return;
  }
  ui.expandedPageId = id;
  hooks.focusPage(id);
}

const renamingId = ref<NodeId | null>(null);
const draftName = ref("");

/* 编辑模式下左栏始终展开活动页的图层 */
watch(
  () => ui.activePageId,
  (id) => {
    if (ui.mode === "edit" && id) ui.expandedPageId = id;
  },
);

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
  const pos = nextPagePosition(docStore.doc);
  const node = createNode("page", {
    name: nextPageName(docStore.doc),
    x: pos.x,
    y: pos.y,
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT,
  });
  dispatch({ type: "node.create", params: { nodes: [node], parentId: null } }, "create-page");
  if (ui.mode === "edit") ui.activePageId = node.id;
  ui.expandedPageId = node.id;
  select([]);
  hooks.focusPage(node.id);
}

function deletePage(page: DocNode) {
  if (pages.value.length <= 1) return;
  if (!window.confirm(`删除页面「${page.name}」及其全部图层？`)) return;
  dispatch({ type: "node.delete", params: { nodeId: page.id } }, "delete-page");
  if (ui.expandedPageId === page.id) ui.expandedPageId = docStore.doc.rootIds[0] ?? null;
  hooks.requestRedraw();
}

/* ---------- 图层操作 ---------- */

function onLayerClick(row: Row, e: MouseEvent) {
  // 编辑模式：点其它页的图层时先切换活动页，再选中（淡化只是提示，不是墙）
  if (ui.mode === "edit" && row.node.parentId && row.node.parentId !== ui.activePageId) {
    ui.activePageId = row.node.parentId;
    ui.expandedPageId = row.node.parentId;
  }
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
          :class="{ active: ui.expandedPageId === page.id, 'active-page': ui.mode === 'edit' && ui.activePageId === page.id }"
          @click="togglePage(page.id)"
        >
          <Icon name="chevron" :size="12" class="caret" :class="{ open: ui.expandedPageId === page.id }" />
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
        <div v-if="ui.expandedPageId === page.id" class="layers">
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
  background: rgba(15, 23, 42, 0.045);
}

/* 编辑模式下的活动页：左侧一道靛蓝标记 */
.page-row.active-page {
  position: relative;
  color: var(--text);
}

.page-row.active-page::before {
  content: "";
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent);
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
  background: rgba(15, 23, 42, 0.05);
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
