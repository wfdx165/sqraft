<script setup lang="ts">
/**
 * 画布左缘的工具竖条（ADR-0041）：拖动 / 编辑模式 + 八个绘图工具。
 *
 * 位置跟左栏宽度走（`--left-w`）；左栏收起（顶栏面板开关或 `⌘\`）时贴到 12px。
 * 顶部胶囊已退场，文件级动作在 `TopBar` 的 `⋯` 里。
 */
import { computed } from "vue";
import { docStore, switchMode, ui, type ToolKind } from "../store";
import { keyLabel, type ActionId } from "../shortcuts";
import { vTip } from "../tooltip";
import { t } from "../i18n";
import type { MessageKey } from "../../shared/i18n";
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

function pickTool(kind: ToolKind): void {
  if (!hasPage.value) return;
  switchMode("edit");
  ui.tool = kind;
}
</script>

<template>
  <div class="rail glass">
    <nav class="group modes">
      <button
        class="btn"
        :class="{ active: ui.mode === 'pan' }"
        v-tip="{ label: t('toolbar.dragCanvas'), shortcut: keyLabel('mode.pan') }"
        @click="switchMode('pan')"
      >
        <Icon name="hand" :size="15" />
      </button>
      <button
        class="btn"
        :class="{ active: ui.mode === 'edit' }"
        v-tip="{ label: t('toolbar.editPage'), shortcut: keyLabel('mode.edit') }"
        @click="switchMode('edit')"
      >
        <Icon name="select" :size="15" />
      </button>
    </nav>

    <span class="divider" />

    <nav class="group">
      <button
        v-for="tool in tools"
        :key="tool.kind"
        class="btn"
        :class="{ active: ui.mode === 'edit' && ui.tool === tool.kind }"
        :disabled="!hasPage"
        v-tip="{ label: hasPage ? t(tool.labelKey) : t('toolbar.newPageFirst'), shortcut: keyLabel(tool.action) }"
        @click="pickTool(tool.kind)"
      >
        <Icon :name="tool.icon" :size="15" />
      </button>
    </nav>
  </div>
</template>

<style scoped>
.rail {
  position: absolute;
  top: 14px;
  left: calc(var(--left-w, 0px) + 12px);
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px;
  border-radius: var(--radius-md);
  transition: left var(--dur-med) var(--ease);
}

.group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  position: relative;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.btn:hover:not(:disabled) {
  background: var(--glass-strong);
  color: var(--text);
}

.btn.active {
  background: var(--glass-strong);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}

.btn.active::after {
  content: "";
  position: absolute;
  left: 3px;
  top: 50%;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
  transform: translateY(-50%);
}

.btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.divider {
  width: 18px;
  height: 1px;
  background: var(--hairline);
  margin: 2px 0;
}
</style>
