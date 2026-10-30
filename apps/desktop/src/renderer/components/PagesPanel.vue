<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  createNode,
  getPages,
  nextPageName,
  nextPagePosition,
  overridePatchOf,
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  type DocNode,
  type NodeId,
} from "@sqraft/core";
import { dispatch, docStore, hooks, select, ui } from "../store";
import { canDeletePage, deletePage as deletePageAction } from "../canvas/page-actions";
import { openNodeMenu, openPageMenu } from "../object-menu";
import { registerShortcuts } from "../shortcuts";
import { planLayerDrop, type DropPosition } from "../canvas/layer-drag";
import { canExpand, isLayerExpanded } from "../canvas/layer-tree";
import Icon from "./Icon.vue";
import { assetUrl } from "../assets";

interface Row {
  node: DocNode;
  depth: number;
}

const pages = computed(() => {
  void ui.version;
  return getPages(docStore.doc);
});

/* ---------- 搜索 ---------- */

const filter = ref("");
const searchEl = ref<HTMLInputElement | null>(null);

/** 归一化后的查询词（空串 = 不过滤）。 */
const query = computed(() => filter.value.trim().toLowerCase());

/**
 * 过滤后的页面列表。正在重命名的那一行始终保留，
 * 避免改名改到一半因为旧名字不匹配而消失在列表里。
 */
const filteredPages = computed(() => {
  const q = query.value;
  if (!q) return pages.value;
  return pages.value.filter((page) => page.name.toLowerCase().includes(q) || page.id === renamingId.value);
});

/** 计数徽标：有查询时显示「命中 / 总数」，否则只显示总数。 */
const countLabel = computed(() => {
  const total = pages.value.length;
  return query.value ? `${filteredPages.value.length} / ${total}` : String(total);
});

/** 把页面名按首次命中的片段切成三段，供高亮渲染。 */
function highlightOf(name: string): { text: string; hit: boolean }[] {
  const q = query.value;
  if (!q) return [{ text: name, hit: false }];
  const at = name.toLowerCase().indexOf(q);
  if (at < 0) return [{ text: name, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  if (at > 0) out.push({ text: name.slice(0, at), hit: false });
  out.push({ text: name.slice(at, at + q.length), hit: true });
  if (at + q.length < name.length) out.push({ text: name.slice(at + q.length), hit: false });
  return out;
}

/** ⌘F：切到页面 tab 并聚焦搜索框；已在框内则全选，方便覆盖重输。 */
function focusSearch(): void {
  ui.tab = "pages";
  nextTick(() => {
    searchEl.value?.focus();
    searchEl.value?.select();
  });
}

let stopSearchShortcut = () => {};
onMounted(() => {
  stopSearchShortcut = registerShortcuts({ "focus.pageSearch": focusSearch });
});
onBeforeUnmount(() => stopSearchShortcut());


/**
 * 当前页面下的图层树（手风琴：仅展开活动页面）。
 * `children` 是"从下往上"的绘制顺序，列表按 Figma 习惯**倒序**显示（最上层在最前），
 * 否则新图层会出现在列表底部，且 `isMask` 遮罩的"上方相邻"会读成"下方相邻"。
 */
const rows = computed<Row[]>(() => {
  void ui.version;
  const pageId = ui.expandedPageId;
  // 只认页面：无页面文档里 expandedPageId 可能被写成母版 id
  if (!pageId || docStore.doc.nodes[pageId]?.type !== "page") return [];
  const out: Row[] = [];
  const visit = (id: NodeId, depth: number) => {
    const node = docStore.doc.nodes[id];
    if (!node) return;
    if (node.type !== "page") out.push({ node, depth });
    // 锁定整棵子树：后代在解锁前不可选
    if (node.locked) return;
    // 容器行可折叠：实例默认折叠，其它容器默认展开（见 isLayerExpanded）
    if (node.children.length > 0 && !isLayerExpanded(node, ui.expandedLayers)) return;
    for (const c of [...node.children].reverse()) visit(c, depth + 1);
  };
  for (const c of [...docStore.doc.nodes[pageId].children].reverse()) visit(c, 0);
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
  component: "component",
  instance: "component",
  slot: "slot",
};

/** 图片图层用缩略图代替类型图标；资源缺失时退回图标。 */
function thumbOf(n: DocNode): string | null {
  return n.image ? assetUrl(n.image.assetId) : null;
}

function toggleLayerLock(n: DocNode): void {
  dispatch({ type: "node.update", params: { nodeId: n.id, patch: { locked: !n.locked } } }, "lock");
}

/* ---------- 图层拖拽 ---------- */

const dragId = ref<NodeId | null>(null);
const dropHint = ref<{ id: NodeId; position: DropPosition } | null>(null);

function onDragStart(row: Row, e: DragEvent) {
  dragId.value = row.node.id;
  e.dataTransfer?.setData("text/plain", row.node.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onDragOver(row: Row, e: DragEvent) {
  if (!dragId.value || dragId.value === row.node.id) return;
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  const box = el.getBoundingClientRect();
  const ratio = (e.clientY - box.top) / Math.max(1, box.height);
  const container = row.node.type === "frame" || row.node.type === "component" || row.node.type === "group";
  // 容器行中间 40% = 放进容器，其余按上下半区插入
  dropHint.value =
    container && ratio > 0.3 && ratio < 0.7
      ? { id: row.node.id, position: "inside" }
      : { id: row.node.id, position: ratio < 0.5 ? "above" : "below" };
}

function onDrop(row: Row) {
  const id = dragId.value;
  const hint = dropHint.value;
  dragId.value = null;
  dropHint.value = null;
  if (!id || !hint) return;
  const plan = planLayerDrop(docStore.doc, id, hint.id, hint.position);
  if (!plan) return;
  dispatch(
    { type: "node.reparent", params: { nodeId: id, parentId: plan.parentId, index: plan.index } },
    "调整层级",
  );
  select([id]);
}

function onDragEnd() {
  dragId.value = null;
  dropHint.value = null;
}

/* ---------- 页面操作 ---------- */

/** 点页面行 = 切活动页 + 适配该页（两种模式一致）；图层展开交给行首小三角。 */
function togglePage(id: NodeId) {
  hooks.activatePage(id);
}

/** 行首小三角：只控制图层列表的展开/折叠，不动视口。 */
function toggleLayers(id: NodeId) {
  ui.expandedPageId = ui.expandedPageId === id ? null : id;
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
  // 新页直接切过去并铺满视口（两种模式一致）
  hooks.activatePage(node.id);
}

function deletePage(page: DocNode) {
  deletePageAction(page.id);
}

/** 页面行右键：与画布上右键页面同一套菜单 */
function onPageMenu(page: DocNode, e: MouseEvent) {
  e.preventDefault();
  openPageMenu(page.id, { x: e.clientX, y: e.clientY });
}

/** 图层行右键：与画布上右键元素同一套菜单 */
function onNodeMenu(node: DocNode, e: MouseEvent) {
  e.preventDefault();
  openNodeMenu(node.id, { x: e.clientX, y: e.clientY });
}

/* ---------- 图层操作 ---------- */

/** 节点所属页面（嵌套图层的 parentId 不是页面）。 */
function pageOf(node: DocNode): string | null {
  let cur: DocNode | undefined = node;
  while (cur && cur.type !== "page") {
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  return cur?.id ?? null;
}

function onLayerClick(row: Row, e: MouseEvent) {
  // 编辑模式：点其它页的图层时先切换活动页，再选中（淡化只是提示，不是墙）
  const pageId = pageOf(row.node);
  if (ui.mode === "edit" && pageId && pageId !== ui.activePageId) {
    ui.activePageId = pageId;
    ui.expandedPageId = pageId;
  }
  if (e.shiftKey) {
    // 多选只改选区，不切换折叠（否则一次多选会连带折掉好几个容器）
    const set = new Set(ui.selection);
    set.has(row.node.id) ? set.delete(row.node.id) : set.add(row.node.id);
    select([...set]);
    hooks.requestRedraw();
    return;
  }
  select([row.node.id]);
  hooks.focusNode(row.node.id); // 选中 + 定位 + 脉冲标记
  if (canExpand(row.node)) toggleLayer(row.node);
}

function hasOverride(node: DocNode): boolean {
  const patch = overridePatchOf(docStore.doc, node.id);
  return Boolean(patch && Object.keys(patch).length);
}

function toggleLayer(node: DocNode): void {
  ui.expandedLayers[node.id] = !isLayerExpanded(node, ui.expandedLayers);
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

    <div class="search-row">
      <input
        ref="searchEl"
        v-model="filter"
        class="search"
        placeholder="搜索页面…"
        spellcheck="false"
        title="过滤页面名称"
      />
      <span class="count" title="命中数 / 总页数">{{ countLabel }}</span>
    </div>

    <div class="pages">
      <div v-if="filteredPages.length === 0" class="empty-pages">没有匹配的页面</div>
      <div v-for="page in filteredPages" :key="page.id" class="page-block">
        <div
          class="page-row"
          :class="{ active: ui.expandedPageId === page.id, 'active-page': ui.mode === 'edit' && ui.activePageId === page.id }"
          @click="togglePage(page.id)"
          @contextmenu.prevent.stop="onPageMenu(page, $event)"
        >
          <button
            class="caret-btn"
            :title="ui.expandedPageId === page.id ? '收起图层' : '展开图层'"
            @click.stop="toggleLayers(page.id)"
          >
            <Icon name="chevron" :size="12" class="caret" :class="{ open: ui.expandedPageId === page.id }" />
          </button>
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
          <span v-else class="page-name" title="双击重命名" @dblclick.stop="startRename(page)">
            <template v-for="(seg, i) in highlightOf(page.name)" :key="i">
              <span v-if="seg.hit" class="hit">{{ seg.text }}</span>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
          <span class="count">{{ layerCount(page) }}</span>
          <button
            v-if="canDeletePage()"
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
            :class="{
              selected: ui.selection.includes(row.node.id),
              dragging: dragId === row.node.id,
              'drop-above': dropHint?.id === row.node.id && dropHint.position === 'above',
              'drop-below': dropHint?.id === row.node.id && dropHint.position === 'below',
              'drop-inside': dropHint?.id === row.node.id && dropHint.position === 'inside',
            }"
            :style="{ paddingLeft: 18 + row.depth * 12 + 'px' }"
            draggable="true"
            @click="onLayerClick(row, $event)"
            @contextmenu.prevent.stop="onNodeMenu(row.node, $event)"
            @dragstart="onDragStart(row, $event)"
            @dragover="onDragOver(row, $event)"
            @drop.prevent="onDrop(row)"
            @dragend="onDragEnd"
          >
            <button
              v-if="canExpand(row.node)"
              class="disclosure"
              :class="{ open: isLayerExpanded(row.node, ui.expandedLayers) }"
              :title="isLayerExpanded(row.node, ui.expandedLayers) ? '折叠子图层' : '展开子图层'"
              @click.stop="toggleLayer(row.node)"
            >
              <Icon name="chevron" :size="10" />
            </button>
            <span v-else class="disclosure-spacer" />
            <img
              v-if="row.node.type === 'image' && thumbOf(row.node)"
              class="thumb"
              :src="thumbOf(row.node)!"
              alt=""
            />
            <Icon v-else class="type" :name="iconOf[row.node.type] ?? 'rect'" :size="13" />
            <span class="name">{{ row.node.name }}</span>
            <span v-if="row.node.type === 'slot'" class="slot-state">
              {{ row.node.slotFilled ? "已填充" : row.node.children.length ? "默认" : "空插槽" }}
            </span>
            <span v-if="hasOverride(row.node)" class="ovr" title="有覆盖" />
            <button
              v-if="row.node.locked"
              class="act lock"
              title="解锁"
              @click.stop="toggleLayerLock(row.node)"
            >🔒</button>
            <button v-else class="act lock ghost" title="锁定" @click.stop="toggleLayerLock(row.node)">🔓</button>
            <button v-if="!row.node.locked" class="act" title="删除" @click.stop="onLayerDelete(row.node.id)"><Icon name="close" :size="11" /></button>
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
  padding: 0 8px 6px;
}

/* 搜索行：输入框 + 命中/总数徽标（样式与设计系统面板保持一致） */
.search-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 8px;
}

.search {
  flex: 1;
  min-width: 0;
  height: 27px;
  padding: 0 9px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--tint-3);
  color: var(--text);
  font-size: 11.5px;
  font-family: inherit;
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

.search:focus {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.count {
  flex: none;
  min-width: 20px;
  text-align: center;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--tint-5);
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 10px;
}

.empty-pages {
  padding: 6px 8px 6px 26px;
  font-size: 11px;
  color: var(--text-faint);
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
  background: var(--tint-5);
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

.caret-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

.caret-btn:hover .caret {
  color: var(--text-dim);
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

/* 搜索命中的片段 */
.hit {
  color: var(--accent);
  font-weight: 600;
}

.rename {
  flex: 1;
  min-width: 0;
  background: var(--tint-5);
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

.thumb {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  object-fit: cover;
  flex: none;
  border: 1px solid var(--hairline);
}

.layers {
  padding: 2px 0 6px;
}

.empty-layer {
  padding: 4px 0 4px 26px;
  font-size: 11px;
  color: var(--text-faint);
}

.row.dragging {
  opacity: 0.45;
}

/* 插入指示线：上方 / 下方 / 放进容器 */
.row.drop-above {
  box-shadow: inset 0 2px 0 var(--accent);
}

.row.drop-below {
  box-shadow: inset 0 -2px 0 var(--accent);
}

.row.drop-inside {
  box-shadow: inset 0 0 0 1px var(--accent-line);
  background: var(--accent-soft);
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

.disclosure {
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transform: rotate(-90deg);
  transition: transform var(--dur-fast) var(--ease);
}

.disclosure.open {
  transform: rotate(0deg);
}

.disclosure-spacer {
  flex: none;
  width: 14px;
}

.ovr {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

.slot-state {
  flex: none;
  font-size: 9.5px;
  color: var(--text-faint);
  border: 1px solid var(--hairline);
  border-radius: 4px;
  padding: 0 4px;
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
