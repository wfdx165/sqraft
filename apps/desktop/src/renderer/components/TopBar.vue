<script setup lang="ts">
/**
 * 顶部模块（ADR-0041）：Home + 文档标签 + `＋`，右端是保存状态、更新、演示与 `⋯`。
 *
 * 固定 34px、贴窗口顶部；macOS 左侧给红绿灯留 80px，整行空白处可拖窗口。
 * 工具不在这里——它们在画布左缘的 `ToolRail`。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { closeTabById, fileState, newDocument, openDocument, reopenClosedTab, saveDocument, saveDocumentAs } from "../file-session";
import { activateTab, ui } from "../store";
import { togglePanels } from "../focus";
import { docTabs, moveTab, sessionState, type TabSession } from "../sessions";
import { keyLabel, registerShortcuts, runAction } from "../shortcuts";
import { tabLabel } from "../tab-label";
import { openContextMenu, type ContextMenuItem } from "../context-menu";
import { openSettings } from "../settings";
import { enterPresenter } from "../presenter";
import { t } from "../i18n";
import {
  checkForUpdates,
  downloadUpdate,
  restartToUpdate,
  updateAvailable,
  updateIncompatible,
  updateReady,
  updateUi,
} from "../update";
import { vTip } from "../tooltip";
import Icon from "./Icon.vue";

const emit = defineEmits<{ about: [] }>();

const platform = window.sqraft.platform;
const isMac = platform === "darwin";
const tabsEl = ref<HTMLElement | null>(null);
const dragId = ref<string | null>(null);

const tabs = computed(() => docTabs());
const savedState = computed(() => (fileState.dirty ? t("tab.unsaved") : t("tab.saved")));
const savedTip = computed(() => {
  const where = fileState.path ?? t("toolbar.notSaved");
  return fileState.dirty ? t("toolbar.unsavedWhere", { where }) : where;
});

function tabName(tab: TabSession): string {
  return tabLabel(tab);
}

function isActive(tab: TabSession): boolean {
  return tab.id === sessionState.activeId;
}

function activate(id: string): void {
  activateTab(id);
}

async function closeOthers(): Promise<void> {
  const keep = sessionState.activeId;
  for (const tab of docTabs()) {
    if (tab.id === keep) continue;
    if (!(await closeTabById(tab.id))) break; // 取消
  }
  if (docTabs().some((tab) => tab.id === keep)) activateTab(keep);
}

async function closeRightOf(id: string): Promise<void> {
  const list = docTabs();
  const index = list.findIndex((tab) => tab.id === id);
  for (const tab of list.slice(index + 1)) {
    if (!(await closeTabById(tab.id))) break; // 取消
  }
  if (docTabs().some((tab) => tab.id === id)) activateTab(id);
}

function onTabContextMenu(e: MouseEvent, tab: TabSession): void {
  const items: ContextMenuItem[] = [
    { label: t("tab.close"), hint: keyLabel("file.closeDoc"), run: () => void closeTabById(tab.id) },
    { label: t("tab.closeOthers"), separator: true, run: () => void closeOthers() },
    { label: t("tab.closeRight"), disabled: tabs.value.at(-1)?.id === tab.id, run: () => void closeRightOf(tab.id) },
  ];
  if (tab.file.path) {
    items.push({
      label: t("tab.reveal"),
      separator: true,
      run: () => void window.sqraft.app.revealPath(tab.file.path!),
    });
  }
  openContextMenu({ x: e.clientX, y: e.clientY }, items);
}

/* ---------- 拖拽排序 ---------- */
function onAuxClick(e: MouseEvent, tab: TabSession): void {
  if (e.button === 1) void closeTabById(tab.id);
}

function onDragStart(e: DragEvent, tab: TabSession): void {
  dragId.value = tab.id;
  e.dataTransfer?.setData("text/plain", tab.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onDrop(e: DragEvent, tab: TabSession): void {
  e.preventDefault();
  const from = dragId.value;
  dragId.value = null;
  if (!from || from === tab.id) return;
  moveTab(from, tab.id);
}

/* ---------- ＋ / ⋯ ---------- */
function menuAt(e: MouseEvent, items: ContextMenuItem[]): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openContextMenu({ x: rect.left, y: rect.bottom + 4 }, items);
}

function openPlusMenu(e: MouseEvent): void {
  menuAt(e, [
    { label: t("tab.new"), hint: keyLabel("file.new"), run: () => void newDocument() },
    { label: t("menu.open"), hint: keyLabel("file.open"), run: () => void openDocument() },
  ]);
}

function openMoreMenu(e: MouseEvent): void {
  const doc = ui.docOpen;
  const items: ContextMenuItem[] = [
    { label: t("tab.new"), hint: keyLabel("file.new"), run: () => void newDocument() },
    { label: t("menu.open"), hint: keyLabel("file.open"), run: () => void openDocument() },
    { label: t("menu.saveAs"), hint: keyLabel("file.saveAs"), disabled: !doc, separator: true, run: () => void saveDocumentAs("action") },
    { label: t("menu.insertImage"), hint: keyLabel("file.insertImage"), disabled: !doc, run: () => runAction("file.insertImage") },
    { label: t("menu.exportMatrix"), hint: keyLabel("file.exportMatrix"), disabled: !doc, run: () => runAction("file.exportMatrix") },
  ];
  items.push(
    { label: t("menu.exportPng1"), disabled: !doc, separator: true, run: () => runAction("file.exportPng1") },
    { label: t("menu.exportPng2"), hint: keyLabel("file.exportPng2"), disabled: !doc, run: () => runAction("file.exportPng2") },
    { label: t("menu.exportPng4"), disabled: !doc, run: () => runAction("file.exportPng4") },
    { label: t("menu.exportSvg"), disabled: !doc, run: () => runAction("file.exportSvg") },
  );
  items.push(
    { label: t("shortcuts.title"), hint: keyLabel("palette.open"), separator: true, run: () => openSettings("shortcuts") },
    { label: t("menu.settings"), run: () => openSettings() },
    { label: t("menu.about"), run: () => emit("about") },
    { label: t("menu.checkUpdates"), separator: true, run: () => { emit("about"); void checkForUpdates(true); } },
  );
  menuAt(e, items);
}

function save(): void {
  if (!ui.docOpen) return;
  void saveDocument("action");
}

function present(): void {
  if (!ui.docOpen) return;
  enterPresenter();
}

/* ---------- ⌘1..9 ---------- */
function onKeyDown(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  if (!/^[1-9]$/.test(e.key)) return;
  const target = sessionState.tabs[Number(e.key) - 1];
  if (!target) return;
  e.preventDefault();
  activateTab(target.id);
}

/** 标签区横向滚动：普通滚轮在标签栏上按横向处理，避免误滚画布。 */
function onTabsWheel(e: WheelEvent): void {
  const el = tabsEl.value;
  if (!el || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  el.scrollLeft += e.deltaY;
  e.preventDefault();
}

/**
 * 活动标签滚进可见区：标签区横向滚动，不滚的话第 6 个以后停在右边看不到。
 * 新建 / 打开 / ⌘1..9 / 关闭后落到相邻标签都走这条。
 */
watch(
  () => sessionState.activeId,
  () => {
    tabsEl.value?.querySelector<HTMLElement>(".tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  },
  { flush: "post" },
);

let unregister = () => {};
onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  unregister = registerShortcuts({
    "file.reopenTab": () => void reopenClosedTab(),
  });
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  unregister();
});
</script>

<template>
  <header class="topbar" :class="{ 'with-lights': isMac }">
    <div class="tabs" ref="tabsEl" @wheel="onTabsWheel">
      <button class="tab home" :class="{ on: sessionState.activeId === 'home' }" @click="activate('home')">
        <Icon name="home" :size="11" class="tab-icon" />
        {{ t("tab.home") }}
      </button>
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab doc"
        :class="{ on: isActive(tab) }"
        draggable="true"
        @click="activate(tab.id)"
        @auxclick="onAuxClick($event, tab)"
        @contextmenu.prevent="onTabContextMenu($event, tab)"
        @dragstart="onDragStart($event, tab)"
        @dragover.prevent
        @drop="onDrop($event, tab)"
      >
        <Icon name="pages" :size="11" class="tab-icon" />
        <span class="name" :title="tab.file.path ?? t('toolbar.notSaved')">{{ tabName(tab) }}</span>
        <span v-if="tab.file.externalChange" class="dot warn" />
        <span v-else-if="tab.file.dirty" class="dot" />
        <button class="x" v-tip="{ label: t('tab.close'), shortcut: keyLabel('file.closeDoc') }" @click.stop="closeTabById(tab.id)">
          <Icon name="close" :size="10" />
        </button>
      </div>
      <button class="plus" v-tip="{ label: t('tab.new') }" @click="openPlusMenu">＋</button>
    </div>

    <div class="actions">
      <button
        v-if="updateReady"
        class="chip update"
        v-tip="{ label: t('update.ready', { version: updateUi.latestVersion ?? '' }) }"
        @click="restartToUpdate"
      >
        <Icon name="update" :size="11" /><span>{{ t("about.restart") }}</span>
      </button>
      <button
        v-else-if="updateAvailable"
        class="chip update"
        v-tip="{ label: t('update.available', { version: updateUi.latestVersion ?? '' }) }"
        @click="downloadUpdate"
      >
        <Icon name="update" :size="11" /><span>{{ t("update.download") }}</span>
      </button>
      <button
        v-else-if="updateIncompatible"
        class="chip update"
        v-tip="{ label: t('update.incompatible', { version: updateUi.latestVersion ?? '', os: updateUi.minOS ?? '' }) }"
        @click="downloadUpdate"
      >
        <Icon name="update" :size="11" /><span>{{ t("update.incompatibleChip", { os: updateUi.minOS ?? "" }) }}</span>
      </button>

      <button v-if="ui.docOpen" class="chip save" :class="{ dirty: fileState.dirty }" v-tip="{ label: savedTip }" @click="save">
        <span class="save-dot" />
        <span class="save-text">{{ savedState }}</span>
      </button>

      <button
        class="icon panel-toggle"
        :class="{ on: !ui.panels.open }"
        :disabled="!ui.docOpen"
        v-tip="{ label: t(ui.panels.open ? 'toolbar.hidePanels' : 'toolbar.showPanels'), shortcut: keyLabel('view.panels') }"
        @click="togglePanels"
      >
        <Icon name="panels" />
      </button>
      <button class="icon" :disabled="!ui.docOpen" v-tip="{ label: t('toolbar.present'), shortcut: keyLabel('view.present') }" @click="present">
        <Icon name="play" />
      </button>
      <button class="icon" v-tip="{ label: t('toolbar.more') }" @click="openMoreMenu">
        <span class="dots">⋯</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 34px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  background: var(--surface-strong);
  border-bottom: 1px solid var(--hairline);
  -webkit-app-region: drag;
  user-select: none;
  transition: transform var(--dur-med) var(--ease);
}

/* macOS：给红绿灯留位，整行仍可拖 */
.topbar.with-lights {
  padding-left: 80px;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -webkit-app-region: no-drag;
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tab {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  cursor: default;
  white-space: nowrap;
  flex: none;
  max-width: 180px;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.tab:hover {
  background: var(--tint-4);
  color: var(--text);
}

.tab.on {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 3px var(--tint-12);
}

.tab .name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-icon {
  color: var(--text-faint);
  flex: none;
}

.tab.on .tab-icon {
  color: var(--accent);
}

.tab .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}

.tab .dot.warn {
  background: var(--danger);
}

.tab .x {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  flex: none;
}

.tab:hover .x,
.tab.on .x {
  opacity: 1;
}

.tab .x:hover {
  background: var(--tint-6);
  color: var(--text);
}

.plus {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-faint);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  flex: none;
}

.plus:hover {
  background: var(--tint-4);
  color: var(--text);
}

.actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  -webkit-app-region: no-drag;
}

.chip {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  flex: none;
}

.chip:hover {
  color: var(--text);
  border-color: var(--hairline-strong);
}

.chip.update {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

.chip.update:hover {
  background: var(--accent);
  color: #fff;
}

.chip.save .save-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-faint);
}

.chip.save.dirty {
  color: var(--accent);
  border-color: var(--accent-line);
}

.chip.save.dirty .save-dot {
  background: var(--accent);
}

.icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  flex: none;
}

.icon:hover:not(:disabled) {
  background: var(--tint-4);
  color: var(--text);
}

.icon:disabled {
  opacity: 0.3;
  cursor: default;
}

/* 面板已收起：开关的激活态（与标签激活同一套观感） */
.icon.on:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}

.icon.on:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}

.dots {
  font-size: 14px;
  line-height: 1;
}

/* 窄窗口：标签优先收缩，状态文字让位（tooltip 仍有全文） */
@media (max-width: 900px) {
  .chip.update span,
  .chip.save .save-text {
    display: none;
  }
  .tab {
    max-width: 140px;
  }
}
</style>
