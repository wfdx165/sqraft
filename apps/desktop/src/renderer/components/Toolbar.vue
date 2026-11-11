<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { docStore, redo, switchMode, ui, undo, type ToolKind } from "../store";
import { closeDocument, fileState, openDocument, saveDocument, saveDocumentAs } from "../file-session";
import { openContextMenu, type ContextMenuItem } from "../context-menu";
import { keyOf, PANEL_BINDING, registerShortcuts, shortcutUi, type ActionId } from "../shortcuts";
import { vTip } from "../tooltip";
import { restartToUpdate, updateReady, updateUi } from "../update";
import { t } from "../i18n";
import { enterPresenter } from "../presenter";
import type { MessageKey } from "../../shared/i18n";
import appIcon from "../brand/app-icon.png";
import Icon from "./Icon.vue";

const tools: { kind: ToolKind; action: ActionId; labelKey: MessageKey; icon: string }[] = [
  { kind: "select", action: "mode.edit", labelKey: "toolbar.select", icon: "select" },
  { kind: "frame", action: "tool.frame", labelKey: "node.frame", icon: "frame" },
  { kind: "rect", action: "tool.rect", labelKey: "node.rect", icon: "rect" },
  { kind: "ellipse", action: "tool.ellipse", labelKey: "node.ellipse", icon: "ellipse" },
  { kind: "triangle", action: "tool.triangle", labelKey: "node.triangle", icon: "triangle" },
  { kind: "line", action: "tool.line", labelKey: "node.line", icon: "line" },
  { kind: "path", action: "tool.path", labelKey: "toolbar.pen", icon: "pen" },
  { kind: "text", action: "tool.text", labelKey: "node.text", icon: "text" },
];

/** 空文档没有页面：绘图工具不可用，先建页再画 */
const hasPage = computed(() => {
  void ui.version;
  return docStore.doc.rootIds.some((id) => docStore.doc.nodes[id]?.type === "page");
});

function present(): void {
  enterPresenter();
}

/* ---------- 窄窗口：低优先级分组收进「⋯」 ---------- */
/** 收起顺序（从最先收起的开始）：文档胶囊 → 打开/保存 → 快捷键入口 → 撤销/重做 */
const OVERFLOW_ORDER = ["doc", "file", "shortcuts", "history"] as const;
type OverflowGroup = (typeof OVERFLOW_ORDER)[number];

const barEl = ref<HTMLElement | null>(null);
const hiddenGroups = ref<Set<OverflowGroup>>(new Set());

/**
 * 溢出收纳：只收不放（宽度变大或面板变化时从零重算），避免"收起→放回"来回抖。
 * 每次只动一组并等一帧，测到的才是真实布局宽度。
 */
async function fitBar(reset: boolean): Promise<void> {
  if (reset) hiddenGroups.value = new Set();
  await nextTick();
  const bar = barEl.value;
  if (!bar) return;
  for (let guard = 0; guard < OVERFLOW_ORDER.length + 1; guard += 1) {
    if (bar.scrollWidth <= bar.clientWidth + 1) return;
    const next = OVERFLOW_ORDER.find((id) => !hiddenGroups.value.has(id));
    if (!next) return;
    hiddenGroups.value = new Set([...hiddenGroups.value, next]);
    await nextTick();
  }
}

/** 「⋯」菜单：把被收起的分组原样放回来。 */
function openOverflowMenu(e: MouseEvent): void {
  const items: ContextMenuItem[] = [];
  if (hiddenGroups.value.has("doc")) {
    items.push({
      label: t("toolbar.currentFile", {
        name: `${docName.value}${docDirty.value ? t("toolbar.unsavedSuffix") : ""}`,
      }),
      disabled: true,
      run: () => {},
    });
    items.push({ label: t("toolbar.backToWelcome"), hint: keyOf("file.closeDoc"), run: () => void onClose() });
  }
  if (hiddenGroups.value.has("file")) {
    items.push({ label: t("menu.open"), hint: keyOf("file.open"), separator: items.length > 0, run: () => void onOpen() });
    items.push({ label: t("menu.save"), hint: keyOf("file.save"), run: () => void onSave() });
  }
  if (hiddenGroups.value.has("history")) {
    items.push({ label: t("menu.undo"), hint: keyOf("edit.undo"), separator: items.length > 0, disabled: !docStore.canUndo, run: () => undo() });
    items.push({ label: t("menu.redo"), hint: keyOf("edit.redo"), disabled: !docStore.canRedo, run: () => redo() });
  }
  if (hiddenGroups.value.has("shortcuts")) {
    items.push({ label: t("shortcuts.title"), hint: PANEL_BINDING, separator: items.length > 0, run: () => toggleShortcuts() });
  }
  openContextMenu({ x: e.clientX, y: e.clientY }, items);
}

/** 点绘图工具自动切到编辑模式（模式分离：拖动模式只浏览） */
function pickTool(kind: ToolKind) {
  if (!hasPage.value) return;
  switchMode("edit");
  ui.tool = kind;
}

async function onOpen() {
  await openDocument();
}
/** 工具栏按钮：来源记 toolbar；快捷键与菜单走下面的 action 变体。 */
async function onSave() {
  await saveDocument("toolbar");
}
async function onSaveAs() {
  await saveDocumentAs("toolbar");
}
function onSaveAction(): void {
  void saveDocument("action");
}
function onSaveAsAction(): void {
  void saveDocumentAs("action");
}
/** 关闭文档回欢迎页（有未保存改动时先问，和 ⌘W 同一条路径） */
async function onClose() {
  await closeDocument();
}

// 当前文件：名字 + 未保存标记（脏状态由 syncTitle 写进 fileState，保存后立刻清掉）
const docName = computed(() => fileState.name || t("common.untitled"));
const docDirty = computed(() => fileState.dirty);
const docTip = computed(() => {
  const where = fileState.path ?? t("toolbar.notSaved");
  return fileState.dirty ? t("toolbar.unsavedWhere", { where }) : where;
});

function toggleShortcuts() {
  shortcutUi.open = !shortcutUi.open;
  shortcutUi.recording = null;
  shortcutUi.error = "";
}

let unregister = () => {};
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let lastWidth = window.innerWidth;

function scheduleFit(reset = false): void {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    void fitBar(reset);
  }, 60);
}

/** 窗口变宽：从零重算；变窄：在当前基础上继续收。 */
function onBarResize(): void {
  const width = window.innerWidth;
  const grew = width > lastWidth;
  lastWidth = width;
  scheduleFit(grew);
}

onMounted(() => {
  unregister = registerShortcuts({
    "file.open": onOpen,
    "file.save": onSaveAction,
    "file.saveAs": onSaveAsAction,
  });
  window.addEventListener("resize", onBarResize);
  void nextTick(() => void fitBar(false));
});
onBeforeUnmount(() => {
  unregister();
  window.removeEventListener("resize", onBarResize);
  if (resizeTimer) clearTimeout(resizeTimer);
});
</script>

<template>
  <header ref="barEl" class="bar glass">
    <span class="brand"><img class="mark" :src="appIcon" alt="" />Sqraft</span>

    <!-- 当前文件：名字（未保存带 •）+ 回欢迎页 -->
    <div v-show="!hiddenGroups.has('doc')" class="doc-chip">
      <Icon name="pages" :size="12" class="doc-icon" />
      <span class="doc-name" :title="docTip">{{ docName }}</span>
      <span v-if="docDirty" class="doc-dot" aria-hidden="true">•</span>
      <button
        class="doc-close"
        v-tip="{ label: t('toolbar.closeDocTip'), shortcut: keyOf('file.closeDoc') }"
        @click="onClose"
      >
        <Icon name="close" :size="11" />
      </button>
    </div>
    <button
      v-show="!hiddenGroups.has('doc')"
      class="doc-chip back"
      v-tip="{ label: t('toolbar.closeDocTip'), shortcut: keyOf('file.closeDoc') }"
      @click="onClose"
    >
      <Icon name="home" :size="12" /><span>{{ t("toolbar.welcome") }}</span>
    </button>

    <!-- 更新就绪：唯一的常驻入口；平时不存在，不占视觉 -->
    <button
      v-if="updateReady"
      class="doc-chip update"
      v-tip="{ label: t('update.ready', { version: updateUi.latestVersion ?? '' }) }"
      @click="restartToUpdate"
    >
      <Icon name="update" :size="12" /><span>{{ t("about.restart") }}</span>
    </button>

    <span v-show="!hiddenGroups.has('doc')" class="divider" />

    <nav class="group modes">
      <button
        class="mode-btn"
        :class="{ active: ui.mode === 'pan' }"
        v-tip="{ label: t('toolbar.dragCanvas'), shortcut: keyOf('mode.pan') }"
        @click="switchMode('pan')"
      >
        <Icon name="hand" :size="13" /><span>{{ t("toolbar.drag") }}</span>
      </button>
      <button
        class="mode-btn"
        :class="{ active: ui.mode === 'edit' }"
        v-tip="{ label: t('toolbar.editPage'), shortcut: keyOf('mode.edit') }"
        @click="switchMode('edit')"
      >
        <Icon name="select" :size="13" /><span>{{ t("toolbar.edit") }}</span>
      </button>
    </nav>

    <span class="divider" />

    <nav class="group">
      <button
        v-for="tool in tools"
        :key="tool.kind"
        class="icon-btn"
        :class="{ active: ui.mode === 'edit' && ui.tool === tool.kind }"
        :disabled="!hasPage"
        v-tip="{ label: hasPage ? t(tool.labelKey) : t('toolbar.newPageFirst'), shortcut: keyOf(tool.action) }"
        @click="pickTool(tool.kind)"
      >
        <Icon :name="tool.icon" />
      </button>
    </nav>
    <span v-show="!hiddenGroups.has('history')" class="divider" />
    <nav v-show="!hiddenGroups.has('history')" class="group">
      <button class="icon-btn" v-tip="{ label: t('menu.undo'), shortcut: keyOf('edit.undo') }" :disabled="!docStore.canUndo" @click="undo">
        <Icon name="undo" />
      </button>
      <button class="icon-btn" v-tip="{ label: t('menu.redo'), shortcut: keyOf('edit.redo') }" :disabled="!docStore.canRedo" @click="redo">
        <Icon name="redo" />
      </button>
    </nav>
    <span v-show="!hiddenGroups.has('file')" class="divider" />
    <nav v-show="!hiddenGroups.has('file')" class="group">
      <button class="icon-btn" v-tip="{ label: t('toolbar.open'), shortcut: keyOf('file.open') }" @click="onOpen"><Icon name="open" /></button>
      <button class="icon-btn" v-tip="{ label: t('menu.save'), shortcut: keyOf('file.save') }" @click="onSave"><Icon name="save" /></button>
    </nav>
    <span v-show="!hiddenGroups.has('shortcuts')" class="divider" />

    <button
      v-show="!hiddenGroups.has('shortcuts')"
      class="icon-btn"
      :class="{ active: shortcutUi.open }"
      data-shortcuts-toggle
      v-tip="{ label: t('shortcuts.title'), shortcut: PANEL_BINDING }"
      @click="toggleShortcuts"
    >
      <Icon name="keyboard" />
    </button>

    <!-- 窄窗口：被收起的分组集中在这里 -->
    <button
      v-show="!hiddenGroups.has('doc')"
      class="icon-btn"
      :disabled="!hasPage"
      v-tip="{ label: t('toolbar.present'), shortcut: keyOf('view.present') }"
      @click="present"
    >
      <Icon name="play" />
    </button>

    <button
      v-if="hiddenGroups.size > 0"
      class="icon-btn overflow"
      v-tip="{ label: t('toolbar.more') }"
      @click="openOverflowMenu"
    >
      <span class="dots">⋯</span>
    </button>
  </header>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-pill);
  /* 窄窗口：收起的分组不进布局，超出的部分由 fitBar 收进「⋯」 */
  overflow: hidden;
}

.bar > * {
  flex: none;
}

.overflow {
  color: var(--text-dim);
}

.dots {
  font-size: 14px;
  line-height: 1;
  letter-spacing: 0.5px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 6px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}

/* 应用图标（打包用的是 1024px 原图，这里放 64px 版本，16px 下 4 倍图足够清晰） */
.mark {
  display: block;
  flex: none;
  width: 16px;
  height: 16px;
  /* 图标自带圆角与透明外边，不要再裁一次，也不要让它参与图片拖拽 */
  -webkit-user-drag: none;
  user-select: none;
  filter: drop-shadow(0 1px 2px rgba(91, 95, 232, 0.35));
}

.group {
  display: flex;
  align-items: center;
  gap: 2px;
}

/*
 * 文档胶囊：不用工具区那种灰色分段底（--tint-4），否则和「拖动/编辑」看起来像同一组。
 * 文件名 = 白底悬浮的"文档标签"；欢迎页 = 幽灵按钮，只在 hover 时浮出底色。
 */
.doc-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
  background: var(--surface);
  box-shadow: 0 1px 2px var(--tint-12);
  color: var(--text);
  font-size: 11.5px;
  font-family: inherit;
  white-space: nowrap;
}

.doc-icon {
  flex: none;
  color: var(--text-faint);
}

.doc-chip.back {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: var(--text-faint);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.doc-chip.back:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 更新胶囊：强调色描边，但保持和文档胶囊同一高度与形状 */
.doc-chip.update {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
  cursor: pointer;
  box-shadow: none;
}

.doc-chip.update:hover {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.doc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}

/* 胶囊里的关闭：像标签页的 ×，不占视觉重量，hover 才浮出底色 */
.doc-close {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin-left: 1px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.doc-close:hover {
  background: var(--tint-6);
  color: var(--text);
}

/* 未保存标记用强调色，一眼能看出"还没落盘" */
.doc-dot {
  flex: none;
  font-size: 13px;
  line-height: 1;
  color: var(--accent);
}

/* 模式分段：拖动 / 编辑 */
.modes {
  gap: 1px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--tint-4);
  border: 1px solid var(--hairline);
}

.mode-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 9px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

.mode-btn:hover {
  color: var(--text);
}

.mode-btn.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 3px var(--tint-12);
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}

.icon-btn:hover:not(:disabled) {
  background: var(--glass-strong);
  color: var(--text);
}

.icon-btn:active:not(:disabled) {
  transform: scale(0.94);
}

.icon-btn.active {
  background: var(--glass-strong);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
  position: relative;
}

.icon-btn.active::after {
  content: "";
  position: absolute;
  bottom: 3px;
  left: 50%;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
  transform: translateX(-50%);
  box-shadow: 0 0 8px var(--accent);
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.divider {
  width: 1px;
  height: 18px;
  background: var(--hairline);
  margin: 0 2px;
}
</style>
