<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watchEffect } from "vue";
import Toolbar from "./components/Toolbar.vue";
import PagesPanel from "./components/PagesPanel.vue";
import InspectorPanel from "./components/InspectorPanel.vue";
import CanvasView from "./components/CanvasView.vue";
import DesignSystemPanel from "./components/DesignSystemPanel.vue";
import ComponentsPanel from "./components/ComponentsPanel.vue";
import ShortcutsPanel from "./components/ShortcutsPanel.vue";
import WelcomeView from "./components/WelcomeView.vue";
import ConnectionStatus from "./components/ConnectionStatus.vue";
import McpSetupPanel from "./components/McpSetupPanel.vue";
import AboutPanel from "./components/AboutPanel.vue";
import ExportPngDialog from "./components/ExportPngDialog.vue";
import ContextMenu from "./components/ContextMenu.vue";
import Icon from "./components/Icon.vue";
import { exportUi, hooks, layoutUi, togglePanel, ui } from "./store";
import { openExportDefault } from "./export-actions";
import { vTip } from "./tooltip";
import { bindingRev, installShortcuts, keyOf, registerShortcuts, runAction, shortcutUi, type ActionId } from "./shortcuts";
import { closeDocument, installFileSession, newDocument } from "./file-session";
import { installMcpHost } from "./mcp-host";
import { pasteFromClipboard } from "./paste";
import { copySelectionAction, cutSelectionAction } from "./canvas/node-clipboard";

/** 菜单里出现的动作：键位同步给主进程，点击回送到渲染层同一个执行器。 */
const MENU_ACTIONS: ActionId[] = [
  "file.new",
  "file.open",
  "file.insertImage",
  "file.save",
  "file.saveAs",
  "file.exportPng",
  "file.closeDoc",
  "edit.copy",
  "edit.cut",
  "edit.undo",
  "edit.paste",
  "edit.redo",
  "view.zoomIn",
  "view.zoomOut",
  "view.zoomReset",
  "view.fit",
  "view.fitAll",
  "view.toggleGrid",
  "view.toggleSnap",
  "view.toggleGuides",
];

const mcpSetupOpen = ref(false);
const aboutOpen = ref(false);
const platform = window.sqraft.platform;

/* ---------- 骨架自适应：窄窗口收起左右面板 ---------- */
/** 低于这个宽度自动收起左栏 / 检查器（再宽回来时按用户偏好恢复） */
const LEFT_HIDE_BELOW = 1040;
const RIGHT_HIDE_BELOW = 1180;

const windowWidth = ref(window.innerWidth);
/** 因窗口变窄而临时收起（用户手动切换会清掉，避免"点了没反应"） */
const autoHidden = reactive({
  left: window.innerWidth < LEFT_HIDE_BELOW,
  right: window.innerWidth < RIGHT_HIDE_BELOW,
});

const leftVisible = computed(() => layoutUi.leftOpen && !autoHidden.left);
const rightVisible = computed(() => layoutUi.rightOpen && !autoHidden.right);

/** 画布可用宽度的两侧占位（工具栏据此居中与收窄） */
const frameStyle = computed(() => ({
  "--left-w": leftVisible.value ? "314px" : "0px",
  "--right-w": rightVisible.value ? "290px" : "0px",
}));

function toggleSide(side: "left" | "right"): void {
  const visible = side === "left" ? leftVisible.value : rightVisible.value;
  if (visible) {
    togglePanel(side);
    return;
  }
  // 当前不可见：先清掉"因窄自动收起"，只有用户偏好本身是关的才需要真正打开。
  // 不能直接 togglePanel：窗口很窄时那会把偏好从"开"翻成"关"，把手看起来没反应。
  autoHidden[side] = false;
  const open = side === "left" ? layoutUi.leftOpen : layoutUi.rightOpen;
  if (!open) togglePanel(side);
}

/* ---------- 折叠把手：面板展开时只在指针贴近那条边时露出 ---------- */
const EDGE_REVEAL_PX = 28;
const nearEdge = reactive({ left: false, right: false });

function onPointerMove(e: PointerEvent): void {
  const leftEdge = leftVisible.value ? 314 : 6;
  const rightEdge = window.innerWidth - (rightVisible.value ? 290 : 6);
  nearEdge.left = Math.abs(e.clientX - leftEdge) <= EDGE_REVEAL_PX;
  nearEdge.right = Math.abs(e.clientX - rightEdge) <= EDGE_REVEAL_PX;
}

function hideEdgeHandles(): void {
  nearEdge.left = false;
  nearEdge.right = false;
}

function onWindowResize(): void {
  const width = window.innerWidth;
  const prev = windowWidth.value;
  windowWidth.value = width;
  if (prev >= LEFT_HIDE_BELOW && width < LEFT_HIDE_BELOW) autoHidden.left = true;
  if (prev < LEFT_HIDE_BELOW && width >= LEFT_HIDE_BELOW) autoHidden.left = false;
  if (prev >= RIGHT_HIDE_BELOW && width < RIGHT_HIDE_BELOW) autoHidden.right = true;
  if (prev < RIGHT_HIDE_BELOW && width >= RIGHT_HIDE_BELOW) autoHidden.right = false;
}

let uninstall = () => {};
let uninstallMenu = () => {};
let uninstallDoc = () => {};
onMounted(() => {
  window.addEventListener("resize", onWindowResize);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("blur", hideEdgeHandles);
  document.documentElement.addEventListener("mouseleave", hideEdgeHandles);
  uninstall = installShortcuts();
  installFileSession();
  installMcpHost();
  uninstallMenu = window.sqraft.menu.onCommand((action) => {
    if (action === "app.mcpSetup") {
      mcpSetupOpen.value = true;
      return;
    }
    if (action === "app.about") {
      aboutOpen.value = true;
      return;
    }
    runAction(action as ActionId);
  });
  // 文档级动作放在根组件：欢迎页没有工具栏，也要能 ⌘N / ⌘W
  uninstallDoc = registerShortcuts({
    "file.new": () => void newDocument(),
    "file.closeDoc": () => void closeDocument(),
    "edit.paste": () => void pasteFromClipboard(),
    // 复制/剪切/全选放在根组件：欢迎页也要能复制文本（画布不在时走原生）
    "edit.copy": () => void copySelectionAction(),
    "edit.cut": () => void cutSelectionAction(),
    "file.exportPng": () => openExportDefault(),
    "edit.selectAll": () => {
      const el = document.activeElement as HTMLElement | null;
      const editing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (editing) document.execCommand("selectAll");
      else hooks.selectAllLayers();
    },
  });
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("blur", hideEdgeHandles);
  document.documentElement.removeEventListener("mouseleave", hideEdgeHandles);
  uninstall();
  uninstallMenu();
  uninstallDoc();
});

watchEffect(() => {
  // 读取 version 以跟踪改键；keyOf 本身依赖响应式 overrides
  void bindingRev.value;
  const map: Record<string, string> = {};
  for (const id of MENU_ACTIONS) map[id] = keyOf(id);
  window.sqraft.menu.setBindings(map);
});
</script>

<template>
  <div class="app" :data-platform="platform" :style="frameStyle">
    <div class="drag-strip" />
    <template v-if="ui.docOpen">
      <CanvasView />
      <Toolbar class="float toolbar rise-in" />
      <!-- 面板收起/展开：窄窗口下自动收起，手动切换优先 -->
      <button
        class="edge-toggle left"
        :class="{ collapsed: !leftVisible, reveal: !leftVisible || nearEdge.left }"
        v-tip="{ label: leftVisible ? '收起左栏' : '展开左栏' }"
        @click="toggleSide('left')"
      >
        <Icon name="chevron" :size="12" :class="['chev', { flip: !leftVisible }]" />
      </button>
      <button
        class="edge-toggle right"
        :class="{ collapsed: !rightVisible, reveal: !rightVisible || nearEdge.right }"
        v-tip="{ label: rightVisible ? '收起检查器' : '展开检查器' }"
        @click="toggleSide('right')"
      >
        <Icon name="chevron" :size="12" :class="['chev', { flip: !rightVisible }]" />
      </button>
      <aside v-if="leftVisible" class="float left glass rise-in" style="animation-delay: 40ms">
        <div class="tabs">
          <button :class="{ on: ui.tab === 'pages' }" @click="ui.tab = 'pages'">页面</button>
          <button :class="{ on: ui.tab === 'components' }" @click="ui.tab = 'components'">组件</button>
          <button :class="{ on: ui.tab === 'tokens' }" @click="ui.tab = 'tokens'">设计系统</button>
        </div>
        <div class="tab-body">
          <PagesPanel v-show="ui.tab === 'pages'" />
          <ComponentsPanel v-show="ui.tab === 'components'" />
          <DesignSystemPanel v-show="ui.tab === 'tokens'" />
        </div>
      </aside>
      <aside v-if="rightVisible" class="float right glass rise-in" style="animation-delay: 80ms">
        <InspectorPanel />
      </aside>
    </template>
    <WelcomeView v-else @open-mcp-setup="mcpSetupOpen = true" />
    <ConnectionStatus v-if="ui.docOpen" />

    <!-- 快捷键面板：居中对话框，放在根节点以避免被工具条的 translate 约束 -->
    <ShortcutsPanel v-if="shortcutUi.open" />
    <McpSetupPanel v-if="mcpSetupOpen" @close="mcpSetupOpen = false" />
    <AboutPanel v-if="aboutOpen" @close="aboutOpen = false" />
    <ExportPngDialog v-if="exportUi.open" />
    <ContextMenu />
  </div>
</template>

<style scoped>
.app {
  position: relative;
  height: 100%;
  overflow: hidden;
  background:
    radial-gradient(900px 480px at 18% -10%, var(--bg-glow), transparent 60%),
    radial-gradient(700px 420px at 92% 108%, rgba(99, 102, 241, 0.05), transparent 60%),
    var(--bg);
}

.float {
  position: absolute;
  z-index: 10;
}

/* macOS 内嵌标题栏：红绿灯占住左上角，给它们让位并留一块可拖拽区域 */
.drag-strip {
  display: none;
}

.app[data-platform="darwin"] .drag-strip {
  display: block;
  position: absolute;
  top: 0;
  left: 0;
  width: 340px;
  height: 46px;
  z-index: 11;
  -webkit-app-region: drag;
}

.app[data-platform="darwin"] .left,
.app[data-platform="darwin"] .right {
  top: 58px;
}

.toolbar {
  top: 14px;
  /* 在"画布区"居中，而不是在窗口里居中：面板收起/展开时工具栏跟着走 */
  left: calc(50% + (var(--left-w, 0px) - var(--right-w, 0px)) / 2);
  translate: -50% 0;
  max-width: calc(100vw - 28px - var(--left-w, 0px) - var(--right-w, 0px));
}

/* 面板折叠把手：贴在面板内侧边缘，竖排居中 */
.edge-toggle {
  position: absolute;
  top: 50%;
  z-index: 12;
  display: grid;
  place-items: center;
  width: 18px;
  height: 44px;
  padding: 0;
  translate: 0 -50%;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--text-faint);
  box-shadow: var(--shadow-float);
  cursor: pointer;
  /* 默认隐藏且不吃指针：面板展开时只有指针贴近才露出来 */
  opacity: 0;
  pointer-events: none;
  transition:
    opacity var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.edge-toggle.reveal {
  opacity: 1;
  pointer-events: auto;
}

.edge-toggle:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.edge-toggle.left {
  left: calc(var(--left-w, 0px) - 6px);
}

.edge-toggle.right {
  right: calc(var(--right-w, 0px) - 6px);
}

.edge-toggle.left.collapsed {
  left: 8px;
}

.edge-toggle.right.collapsed {
  right: 8px;
}

/* chevron 图标朝下：左把手收到面板边时指左，收起后指右（点它展开） */
.chev {
  transform: rotate(90deg);
}

.chev.flip {
  transform: rotate(-90deg);
}

.edge-toggle.right .chev {
  transform: rotate(-90deg);
}

.edge-toggle.right .chev.flip {
  transform: rotate(90deg);
}

.left {
  top: 14px;
  bottom: 14px;
  left: 14px;
  width: 300px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tabs {
  display: flex;
  gap: 2px;
  margin: 10px 10px 0;
  padding: 2px;
  background: var(--tint-4);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
}

.tabs button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: var(--radius-pill);
  padding: 4px 8px;
  font-size: 11.5px;
  font-family: inherit;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.tabs button:hover {
  color: var(--text);
}

.tabs button.on {
  background: var(--glass-strong);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}

.tabs kbd {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--text-faint);
  border: 1px solid var(--hairline);
  border-radius: 4px;
  padding: 0 3px;
}

.tab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.tab-body > * {
  flex: 1;
  min-height: 0;
}

.right {
  top: 14px;
  bottom: 14px;
  right: 14px;
  width: 276px;
  overflow: auto;
}
</style>
