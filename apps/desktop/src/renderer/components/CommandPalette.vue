<script setup lang="ts">
/**
 * ⌘K 命令面板：命令 + 页面 + 图层 + Token + 最近文件。
 * 扫描与打分在 `palette-search` / `palette-sources`，这里只做合并、键盘与动作。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { AppCommand } from "../shared/commands";
import type { NodeId } from "@sqraft/core";
import { docStore, hooks, ui } from "../store";
import { openDocumentPath } from "../file-session";
import { focusToken } from "../token-focus";
import { hasExecutor, keyLabel, runAction, type ActionId } from "../shortcuts";
import { paletteUi, recordCommand, togglePalette } from "../palette";
import { isAvailable, scoreLabel, searchCommands } from "../palette-search";
import {
  collectLayerItems,
  collectPageItems,
  collectTokenItems,
  rankSources,
  type SourceItem,
  type SourceKind,
} from "../palette-sources";
import { t } from "../i18n";

type RowKind = "command" | SourceKind;

interface Row {
  key: string;
  kind: RowKind;
  label: string;
  hint: string;
  score: number;
  command?: AppCommand;
  pageId?: NodeId;
  nodeId?: NodeId;
  tokenPath?: string;
  filePath?: string;
  locked?: boolean;
  hidden?: boolean;
}

interface Section {
  title: string | null;
  start: number;
  rows: Row[];
}

const KIND_ORDER: RowKind[] = ["command", "page", "layer", "token", "file"];
const input = ref<HTMLInputElement | null>(null);
const files = ref<{ path: string; name: string }[]>([]);
const debouncedQuery = ref(paletteUi.query);
let previous: HTMLElement | null = null;
let layerTimer: ReturnType<typeof setTimeout> | undefined;

function available(command: AppCommand): boolean {
  if (
    !isAvailable(command, {
      docOpen: ui.docOpen,
      selection: ui.selection.length > 0,
      presenter: Boolean(ui.presenter),
    })
  ) {
    return false;
  }
  return command.owner === "main" || hasExecutor(command.id);
}

function sourceRow(item: SourceItem, score = 0): Row {
  return {
    key: `${item.kind}:${item.id}`,
    kind: item.kind,
    label: item.label,
    hint: item.hint,
    score,
    pageId: item.kind === "page" ? item.id : undefined,
    nodeId: item.kind === "layer" ? item.id : undefined,
    tokenPath: item.kind === "token" ? item.id : undefined,
    filePath: item.kind === "file" ? item.id : undefined,
    locked: item.locked,
    hidden: item.hidden,
  };
}

function commandRow(command: AppCommand, query: string): Row {
  const label = t(command.labelKey);
  return {
    key: `command:${command.id}`,
    kind: "command",
    label,
    hint: "",
    score: query ? scoreLabel(query, label) : 0,
    command,
  };
}

const pageItems = computed<SourceItem[]>(() => {
  void ui.version;
  return ui.docOpen ? collectPageItems(docStore.doc) : [];
});

const layerItems = computed<SourceItem[]>(() => {
  void ui.version;
  const query = debouncedQuery.value.trim();
  if (!ui.docOpen || query.length < 2) return [];
  return collectLayerItems(docStore.doc, ui.activePageId, query.length >= 3 ? "document" : "page");
});

const tokenItems = computed<SourceItem[]>(() => {
  void ui.version;
  if (!ui.docOpen || paletteUi.query.trim().length < 2) return [];
  return collectTokenItems(docStore.doc);
});

const fileItems = computed<SourceItem[]>(() =>
  files.value.map((file) => ({
    kind: "file" as const,
    id: file.path,
    label: file.name,
    hint: file.path.replace(/[^/\\]+$/, ""),
  })),
);

function rankedExtras(query: string): Row[] {
  const items = [...pageItems.value, ...layerItems.value, ...tokenItems.value, ...fileItems.value];
  return rankSources(query, items, 50).map((item) => sourceRow(item, item.score));
}

function mergeRows(rows: Row[]): Row[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.score - a.score ||
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, 50);
}

const sections = computed<Section[]>(() => {
  const query = paletteUi.query.trim();
  const result = searchCommands(paletteUi.query, paletteUi.recent, available, (command) => t(command.labelKey));

  if (!query) {
    const out: Section[] = [];
    let start = 0;
    const push = (title: string, rows: Row[]) => {
      if (rows.length === 0) return;
      out.push({ title, start, rows });
      start += rows.length;
    };
    push(t("palette.group.recent"), result.recent.map((command) => commandRow(command, "")));
    push(t("palette.group.commands"), result.commands.map((command) => commandRow(command, "")));
    push(t("palette.badge.page"), pageItems.value.slice(0, 8).map((item) => sourceRow(item)));
    push(t("palette.group.files"), fileItems.value.slice(0, 5).map((item) => sourceRow(item)));
    return out;
  }

  const commandRows = result.commands.map((command) => commandRow(command, query));
  // 1 个字只出命令，避免首屏全是噪音
  const extras = query.length >= 2 ? rankedExtras(query) : [];
  const rows = mergeRows([...commandRows, ...extras]);
  return rows.length > 0 ? [{ title: null, start: 0, rows }] : [];
});

const flat = computed<Row[]>(() => sections.value.flatMap((section) => section.rows));

watch(
  () => paletteUi.query,
  (query) => {
    paletteUi.active = 0;
    clearTimeout(layerTimer);
    if (query.trim().length < 2) {
      debouncedQuery.value = query;
      return;
    }
    layerTimer = setTimeout(() => {
      debouncedQuery.value = query;
    }, 80);
  },
);

watch(
  () => flat.value.length,
  (length) => {
    if (length === 0) paletteUi.active = 0;
    else if (paletteUi.active >= length) paletteUi.active = length - 1;
  },
);

/** 键盘移动选中项时要跟着滚动；用 nearest 让她只在越界时动，鼠标划过不抖。 */
watch(
  () => paletteUi.active,
  (index) => {
    document.getElementById(`palette-item-${index}`)?.scrollIntoView({ block: "nearest" });
  },
  { flush: "post" },
);

watch(
  () => Boolean(ui.presenter),
  (presenting) => {
    if (presenting) togglePalette(false);
  },
);

onMounted(() => {
  previous = document.activeElement as HTMLElement | null;
  void nextTick(() => input.value?.focus());
  void window.sqraft.recent.list().then((list) => {
    files.value = list.slice(0, 5);
  });
});

onBeforeUnmount(() => {
  clearTimeout(layerTimer);
  previous?.focus?.();
});

function close(): void {
  togglePalette(false);
}

function move(delta: number): void {
  const length = flat.value.length;
  if (length === 0) return;
  paletteUi.active = (paletteUi.active + delta + length) % length;
}

function onKey(event: KeyboardEvent): void {
  if (event.isComposing) return;
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      move(1);
      return;
    case "ArrowUp":
      event.preventDefault();
      move(-1);
      return;
    case "PageDown":
      event.preventDefault();
      move(8);
      return;
    case "PageUp":
      event.preventDefault();
      move(-8);
      return;
    case "Home":
      event.preventDefault();
      paletteUi.active = 0;
      return;
    case "End":
      event.preventDefault();
      paletteUi.active = Math.max(0, flat.value.length - 1);
      return;
    case "Enter":
      event.preventDefault();
      void run(flat.value[paletteUi.active]);
      return;
    case "Escape":
      event.preventDefault();
      close();
      return;
    default:
      return;
  }
}

async function run(row: Row | undefined): Promise<void> {
  if (!row) return;
  close();
  if (row.kind === "command" && row.command) {
    recordCommand(row.command.id);
    if (row.command.owner === "renderer") runAction(row.command.id);
    else await window.sqraft.app.runCommand(row.command.id);
    return;
  }
  if (row.kind === "page" && row.pageId) {
    hooks.activatePage(row.pageId);
    return;
  }
  if (row.kind === "layer" && row.nodeId) {
    hooks.focusNode(row.nodeId);
    return;
  }
  if (row.kind === "token" && row.tokenPath) {
    ui.tab = "tokens";
    focusToken(row.tokenPath);
    return;
  }
  if (row.kind === "file" && row.filePath) {
    await openDocumentPath(row.filePath);
  }
}

function keyOfCommand(command: AppCommand | undefined): string {
  return command?.default ? keyLabel(command.id as ActionId) : "";
}

function badgeOf(row: Row): string {
  switch (row.kind) {
    case "command":
      return t("palette.badge.command");
    case "page":
      return t("palette.badge.page");
    case "layer":
      return t("palette.badge.layer");
    case "token":
      return t("palette.badge.token");
    case "file":
      return t("palette.badge.file");
  }
}
</script>

<template>
  <div class="overlay" @mousedown.self="close">
    <div class="panel glass" role="dialog" aria-modal="true" aria-label="Command palette" @keydown="onKey">
      <input
        ref="input"
        v-model="paletteUi.query"
        class="query"
        type="text"
        spellcheck="false"
        autocomplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-controls="palette-list"
        :aria-activedescendant="flat.length > 0 ? `palette-item-${paletteUi.active}` : undefined"
        :placeholder="t('palette.placeholder')"
      />

      <div id="palette-list" class="list" role="listbox">
        <template v-for="section in sections" :key="section.title ?? 'results'">
          <div v-if="section.title" class="section">{{ section.title }}</div>
          <div
            v-for="(row, offset) in section.rows"
            :id="`palette-item-${section.start + offset}`"
            :key="row.key"
            class="row"
            :class="{ active: paletteUi.active === section.start + offset }"
            role="option"
            :aria-selected="paletteUi.active === section.start + offset"
            @mousemove="paletteUi.active = section.start + offset"
            @click="run(row)"
          >
            <span class="badge">{{ badgeOf(row) }}</span>
            <span class="label">{{ row.label }}</span>
            <span v-if="row.locked" class="meta">{{ t("palette.layer.locked") }}</span>
            <span v-if="row.hidden" class="meta">{{ t("palette.layer.hidden") }}</span>
            <span v-if="row.hint" class="hint">{{ row.hint }}</span>
            <span v-if="row.kind === 'command'" class="keys">{{ keyOfCommand(row.command) }}</span>
          </div>
        </template>
        <p v-if="flat.length === 0" class="empty">
          {{ paletteUi.query.trim() ? t("palette.noMatch") : t("palette.empty") }}
        </p>
      </div>

      <footer class="hints">
        <span>{{ t("palette.hint.navigate") }}</span>
        <span>{{ t("palette.hint.run") }}</span>
        <span>{{ t("palette.hint.close") }}</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: absolute;
  inset: 0;
  z-index: 60;
  background: var(--mask);
  backdrop-filter: blur(2px);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
}

.panel {
  width: min(620px, 92vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  border: 1px solid var(--hairline);
  background: var(--glass-strong);
  overflow: hidden;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22);
}

.query {
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 15px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--hairline);
}

.query::placeholder {
  color: var(--text-faint);
}

.list {
  overflow: auto;
  padding: 6px;
}

.section {
  font-size: 10.5px;
  color: var(--text-faint);
  padding: 6px 10px 4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 10px;
  border-radius: 7px;
  cursor: pointer;
  color: var(--text);
}

.row.active {
  background: var(--tint-6, var(--glass-strong));
}

.badge {
  flex: none;
  font-size: 10px;
  color: var(--text-faint);
  border: 1px solid var(--hairline);
  border-radius: 999px;
  padding: 0 6px;
}

.label {
  flex: none;
  max-width: 45%;
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hint {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

.meta {
  flex: none;
  font-size: 10px;
  color: var(--warning, #a8641a);
}

.keys {
  flex: none;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
}

.empty {
  margin: 0;
  padding: 18px 12px;
  font-size: 12px;
  color: var(--text-dim);
  text-align: center;
}

.hints {
  display: flex;
  gap: 16px;
  padding: 8px 14px;
  border-top: 1px solid var(--hairline);
  font-size: 10.5px;
  color: var(--text-faint);
}
</style>
