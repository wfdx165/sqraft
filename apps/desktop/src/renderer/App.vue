<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, watchEffect } from "vue";
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
import SettingsPanel from "./components/SettingsPanel.vue";
import ExportPngDialog from "./components/ExportPngDialog.vue";
import ContextMenu from "./components/ContextMenu.vue";
import Toast from "./components/Toast.vue";
import TokenPicker from "./components/TokenPicker.vue";
import { exportUi, hooks, ui } from "./store";
import { openExportDefault } from "./export-actions";
import { bindingRev, installShortcuts, keyOf, registerShortcuts, runAction, shortcutUi, type ActionId } from "./shortcuts";
import { closeDocument, installFileSession, newDocument, syncTitle } from "./file-session";
import { installMcpHost } from "./mcp-host";
import { pasteFromClipboard } from "./paste";
import { copySelectionAction, cutSelectionAction } from "./canvas/node-clipboard";
import { checkForUpdates, installUpdates } from "./update";
import { locale, t } from "./i18n";

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
const settingsOpen = ref(false);
const platform = window.sqraft.platform;

/** 切换语言后窗口标题里的「未命名 / Untitled」也要跟着变；画布标签字体也随语言换栈。 */
watch(locale, () => {
  if (ui.docOpen) syncTitle();
  hooks.requestRedraw();
});

let uninstall = () => {};
let uninstallMenu = () => {};
let uninstallDoc = () => {};
onMounted(() => {
  uninstall = installShortcuts();
  installFileSession();
  installMcpHost();
  installUpdates();
  uninstallMenu = window.sqraft.menu.onCommand((action) => {
    if (action === "app.mcpSetup") {
      mcpSetupOpen.value = true;
      return;
    }
    if (action === "app.about") {
      aboutOpen.value = true;
      return;
    }
    if (action === "app.settings") {
      settingsOpen.value = true;
      return;
    }
    if (action === "app.checkUpdates") {
      // 菜单入口 = 手动检查：结果落在关于面板里（失败原因同时 toast 一次）
      aboutOpen.value = true;
      void checkForUpdates(true);
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
  <div class="app" :data-platform="platform">
    <div class="drag-strip" />
    <template v-if="ui.docOpen">
      <CanvasView />
      <Toolbar class="float toolbar rise-in" />
      <aside class="float left glass rise-in" style="animation-delay: 40ms">
        <div class="tabs">
          <button :class="{ on: ui.tab === 'pages' }" @click="ui.tab = 'pages'">{{ t("panel.pages") }}</button>
          <button :class="{ on: ui.tab === 'components' }" @click="ui.tab = 'components'">{{ t("panel.components") }}</button>
          <button :class="{ on: ui.tab === 'tokens' }" @click="ui.tab = 'tokens'">{{ t("panel.designSystem") }}</button>
        </div>
        <div class="tab-body">
          <PagesPanel v-show="ui.tab === 'pages'" />
          <ComponentsPanel v-show="ui.tab === 'components'" />
          <DesignSystemPanel v-show="ui.tab === 'tokens'" />
        </div>
      </aside>
      <aside class="float right glass rise-in" style="animation-delay: 80ms">
        <InspectorPanel />
      </aside>
    </template>
    <WelcomeView v-else @open-mcp-setup="mcpSetupOpen = true" />
    <ConnectionStatus v-if="ui.docOpen" />

    <!-- 快捷键面板：居中对话框，放在根节点以避免被工具条的 translate 约束 -->
    <ShortcutsPanel v-if="shortcutUi.open" />
    <McpSetupPanel v-if="mcpSetupOpen" @close="mcpSetupOpen = false" />
    <AboutPanel v-if="aboutOpen" @close="aboutOpen = false" />
    <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />
    <ExportPngDialog v-if="exportUi.open" />
    <Toast />
    <TokenPicker />
    <ContextMenu />
  </div>
</template>

<style scoped>
.app {
  /* 左右面板常驻：面板 300/276 + 边距，工具栏的居中公式按这两个变量算 */
  --left-w: 314px;
  --right-w: 290px;
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
  /* 在"画布区"居中，而不是在窗口里居中：左右面板各占一段固定宽度 */
  left: calc(50% + (var(--left-w, 0px) - var(--right-w, 0px)) / 2);
  translate: -50% 0;
  max-width: calc(100vw - 28px - var(--left-w, 0px) - var(--right-w, 0px));
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
