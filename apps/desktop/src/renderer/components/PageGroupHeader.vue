<script setup lang="ts">
import { ref } from "vue";
import type { PageGroup } from "@sqraft/core";
import { t } from "../i18n";
import {
  createPageInGroup,
  openPageGroupMenu,
  renamePageGroup,
  toggleGroupLocked,
  toggleGroupVisible,
} from "../canvas/page-group-actions";
import Icon from "./Icon.vue";

const props = defineProps<{
  group: PageGroup;
  pageCount: number;
  collapsed: boolean;
  dropActive: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
  dragover: [e: DragEvent];
  dragleave: [];
  drop: [e: DragEvent];
}>();

const renaming = ref(false);
const draft = ref("");

function startRename() {
  renaming.value = true;
  draft.value = props.group.name;
}

function commitRename() {
  if (!renaming.value) return;
  renaming.value = false;
  renamePageGroup(props.group.id, draft.value);
}

function cancelRename() {
  renaming.value = false;
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  openPageGroupMenu(props.group.id, { x: e.clientX, y: e.clientY }, startRename);
}
</script>

<template>
  <div
    class="group-header"
    :class="{
      hidden: group.visible === false,
      locked: group.locked === true,
      'drop-active': dropActive,
    }"
    @click="emit('toggle')"
    @contextmenu.prevent.stop="onContextMenu"
    @dragover="emit('dragover', $event)"
    @dragleave="emit('dragleave')"
    @drop.prevent="emit('drop', $event)"
  >
    <Icon name="chevron" :size="11" class="caret" :class="{ open: !collapsed }" />
    <span class="dot" :style="{ background: group.color || 'var(--accent)' }" />
    <input
      v-if="renaming"
      v-model="draft"
      class="rename"
      autofocus
      @click.stop
      @blur="commitRename"
      @keydown.enter.prevent="commitRename"
      @keydown.esc.prevent="cancelRename"
    />
    <span v-else class="group-name" :title="t('pageGroups.renameHint')" @dblclick.stop="startRename">
      {{ group.name }}
    </span>
    <span class="count">{{ pageCount }}</span>
    <button
      class="act ghost"
      :disabled="group.locked === true"
      :title="t('pageGroups.addPage')"
      @click.stop="createPageInGroup(group.id)"
    >
      <Icon name="plus" :size="11" />
    </button>
    <button
      class="act"
      :class="{ ghost: group.visible !== false }"
      :title="group.visible === false ? t('pageGroups.show') : t('pageGroups.hide')"
      @click.stop="toggleGroupVisible(group.id)"
    >
      <Icon :name="group.visible === false ? 'eye-off' : 'eye'" :size="11" />
    </button>
    <button
      class="act lock"
      :class="{ ghost: !group.locked }"
      :title="group.locked ? t('pageGroups.unlock') : t('pageGroups.lock')"
      @click.stop="toggleGroupLocked(group.id)"
    >
      {{ group.locked ? "🔒" : "🔓" }}
    </button>
  </div>
</template>

<style scoped>
.group-header {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 6px;
  border-radius: 7px;
  cursor: pointer;
  color: var(--text-dim);
  font-size: 11.5px;
  font-weight: 600;
  transition: background var(--dur-fast) var(--ease), outline-color var(--dur-fast) var(--ease);
}

.group-header:hover {
  background: var(--tint-4);
  color: var(--text);
}

.group-header.hidden {
  opacity: 0.55;
}

.group-header.drop-active {
  background: var(--accent-soft);
  outline: 1.5px dashed var(--accent);
  outline-offset: -1.5px;
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

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rename {
  flex: 1;
  min-width: 0;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--accent-line);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-size: 11.5px;
  font-family: inherit;
  outline: none;
}

.count {
  flex: none;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-faint);
  padding: 0 4px;
}

.act {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 10px;
}

.act:hover:not(:disabled) {
  background: var(--tint-6);
  color: var(--text);
}

.act:disabled {
  opacity: 0.3;
  cursor: default;
}

.act.ghost {
  opacity: 0;
}

.group-header:hover .act.ghost {
  opacity: 0.7;
}

.group-header:hover .act.ghost:hover {
  opacity: 1;
}
</style>
