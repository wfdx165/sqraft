<script setup lang="ts">
/**
 * 设计系统面板：按路径前缀分组展示 Token，可改值、可新增、双击改名。
 * 所有写入都走命令（`token.define` / `token.rename`，文档变更唯一入口，可撤销）；不支持删除。
 */
import { computed, nextTick, ref } from "vue";
import { tokenColorOf, tokenNumberOf, tokenPathOf, type TokenEntry } from "@sqraft/core";
import { dispatch, docStore, ui } from "../store";
import Icon from "./Icon.vue";

interface Row {
  path: string;
  entry: TokenEntry;
}

const filter = ref("");
const collapsed = ref<Record<string, boolean>>({});

function prefixOf(path: string): string {
  const i = path.indexOf("/");
  return i > 0 ? path.slice(0, i) : "其它";
}

const groups = computed(() => {
  void ui.version;
  const q = filter.value.trim().toLowerCase();
  const buckets = new Map<string, Row[]>();
  for (const [path, entry] of Object.entries(docStore.doc.tokens)) {
    if (q && !path.toLowerCase().includes(q)) continue;
    const prefix = prefixOf(path);
    const list = buckets.get(prefix) ?? [];
    list.push({ path, entry });
    buckets.set(prefix, list);
  }
  return [...buckets.entries()]
    .map(([prefix, rows]) => ({ prefix, rows: rows.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
});

const total = computed(() => {
  void ui.version;
  return Object.keys(docStore.doc.tokens).length;
});

function toggle(prefix: string) {
  collapsed.value[prefix] = !collapsed.value[prefix];
}

/* ---------- 改值 ---------- */

/** 与 AI 工具共用 core 的判定；浏览器里再让 CSS.supports 兜一次底。 */
function isValidColor(value: string): boolean {
  const color = tokenColorOf(value);
  return color !== null && (typeof CSS === "undefined" || CSS.supports("color", color));
}

function isValidNumber(value: string): boolean {
  return tokenNumberOf(value) !== null;
}

function commit(path: string, tokenType: "color" | "number", raw: string): void {
  const entry = docStore.doc.tokens[path];
  if (!entry) return;
  const value = raw.trim();
  if (tokenType === "color" ? !isValidColor(value) : !isValidNumber(value)) {
    flashInvalid(path);
    return;
  }
  if (value === String(entry.value)) return;
  const next = tokenType === "color" ? value : Number(value);
  dispatch({ type: "token.define", params: { path, tokenType, value: next } }, "token-edit");
}

const invalidPath = ref("");
let invalidTimer = 0;
function flashInvalid(path: string) {
  invalidPath.value = path;
  window.clearTimeout(invalidTimer);
  invalidTimer = window.setTimeout(() => (invalidPath.value = ""), 1200);
}

/** 系统取色器只认 `#rrggbb`；其它写法（rgb()/3 位 hex）原样回退。 */
function hexOf(value: string | number): string {
  const v = String(value).trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return "#000000";
}

function onPick(path: string, e: Event): void {
  commit(path, "color", (e.target as HTMLInputElement).value);
}

/* ---------- 新增 ---------- */

const adding = ref(false);
const draft = ref({ path: "", type: "color" as "color" | "number", value: "" });
const addError = ref("");

function startAdd(groupPrefix?: string) {
  adding.value = true;
  addError.value = "";
  draft.value = {
    path: groupPrefix ? `${groupPrefix}/` : "",
    type: groupPrefix === "color" ? "color" : groupPrefix ? "number" : "color",
    value: "",
  };
}

/** 路径校验：新增与改名共用（至少两段、无空格/空段、不重复）。 */
function validatePath(path: string): string {
  if (!tokenPathOf(path)) return "路径需至少两段且不含空格，如 color/brand";
  if (docStore.doc.tokens[path]) return "该路径已存在，直接改值即可";
  return "";
}

function submitAdd() {
  const path = draft.value.path.trim();
  const pathError = validatePath(path);
  if (pathError) {
    addError.value = pathError;
    return;
  }
  const value = draft.value.value.trim();
  if (draft.value.type === "color" ? !isValidColor(value) : !isValidNumber(value)) {
    addError.value = draft.value.type === "color" ? "颜色需为 #hex / rgb() / rgba()" : "请输入有效数字";
    return;
  }
  dispatch(
    {
      type: "token.define",
      params: {
        path,
        tokenType: draft.value.type,
        value: draft.value.type === "color" ? value : Number(value),
      },
    },
    "token-add",
  );
  adding.value = false;
  addError.value = "";
  draft.value = { path: "", type: "color", value: "" };
}

/* ---------- 改名（引用随动是核心的原子命令） ---------- */

const renamingPath = ref<string | null>(null);
const renameDraft = ref("");
const renameError = ref("");

function startRename(path: string) {
  renamingPath.value = path;
  renameDraft.value = path;
  renameError.value = "";
  addError.value = "";
  // 输入框在 v-for 内，模板 ref 会被收集成数组，改用唯一 class 定位
  void nextTick(() => document.querySelector<HTMLInputElement>(".path-edit")?.focus());
}

/** 聚焦即全选：改名通常只想替换路径末段时也不会误伤整体 */
function onRenameFocus(e: Event) {
  (e.target as HTMLInputElement).select();
}

function cancelRename() {
  renamingPath.value = null;
  renameError.value = "";
}

function commitRename() {
  const from = renamingPath.value;
  if (from === null) return;
  const to = renameDraft.value.trim();
  if (to === from) {
    cancelRename();
    return;
  }
  const error = validatePath(to);
  if (error) {
    renameError.value = error;
    return;
  }
  dispatch({ type: "token.rename", params: { from, to } }, "token-rename");
  cancelRename();
}
</script>

<template>
  <div class="tokens">
    <header class="top">
      <input v-model="filter" class="search" placeholder="筛选 Token…" spellcheck="false" />
      <span class="count">{{ total }}</span>
    </header>

    <div class="list">
      <section v-for="g in groups" :key="g.prefix" class="group">
        <button class="group-head" @click="toggle(g.prefix)">
          <Icon name="chevron" :size="11" class="caret" :class="{ closed: collapsed[g.prefix] }" />
          <span class="prefix">{{ g.prefix }}</span>
          <span class="badge">{{ g.rows.length }}</span>
        </button>

        <template v-if="!collapsed[g.prefix]">
          <div
            v-for="row in g.rows"
            :key="row.path"
            class="row"
            :class="{ invalid: invalidPath === row.path }"
            @dblclick="startRename(row.path)"
          >
            <label v-if="row.entry.type === 'color'" class="swatch" :style="{ background: String(row.entry.value) }">
              <input type="color" :value="hexOf(row.entry.value)" @change="onPick(row.path, $event)" />
            </label>
            <span v-else class="swatch number-dot">#</span>

            <input
              v-if="renamingPath === row.path"
              v-model="renameDraft"
              class="path path-edit mono"
              spellcheck="false"
              @focus="onRenameFocus"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
            />
            <span v-else class="path" :title="row.path">{{ row.path }}</span>

            <button v-if="renamingPath !== row.path" class="edit-path" title="双击改名" @click="startRename(row.path)">
              <Icon name="pencil" :size="11" />
            </button>

            <input
              v-if="renamingPath !== row.path"
              class="value mono"
              :value="row.entry.value"
              spellcheck="false"
              @change="commit(row.path, row.entry.type, ($event.target as HTMLInputElement).value)"
            />
          </div>
        </template>
      </section>

      <p v-if="total === 0" class="empty">还没有 Token</p>
      <p v-else-if="groups.length === 0" class="empty">无匹配 Token</p>
    </div>

    <footer class="foot">
      <p v-if="renameError" class="add-error">{{ renameError }}</p>
      <form v-if="adding" class="add-form" @submit.prevent="submitAdd">
        <div class="add-line">
          <input v-model="draft.path" class="path-input mono" placeholder="color/brand" spellcheck="false" autofocus />
          <select v-model="draft.type" class="type">
            <option value="color">颜色</option>
            <option value="number">数值</option>
          </select>
        </div>
        <div class="add-line">
          <input v-model="draft.value" class="value-input mono" :placeholder="draft.type === 'color' ? '#3366ff' : '12'" spellcheck="false" />
          <button type="submit" class="mini primary">添加</button>
          <button type="button" class="mini" @click="adding = false">取消</button>
        </div>
        <p v-if="addError" class="add-error">{{ addError }}</p>
      </form>
      <button v-else class="add" @click="startAdd()"><Icon name="plus" :size="12" />新增 Token</button>
    </footer>
  </div>
</template>

<style scoped>
.tokens {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 8px 10px 10px;
  gap: 8px;
}

.top {
  display: flex;
  align-items: center;
  gap: 6px;
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

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.group + .group {
  margin-top: 2px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  height: 24px;
  padding: 0 6px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-family: inherit;
  font-size: 10.5px;
  letter-spacing: 0.02em;
  cursor: pointer;
}

.caret {
  transform: rotate(0deg);
  transition: transform var(--dur-fast) var(--ease);
}

.caret.closed {
  transform: rotate(-90deg);
}

.prefix {
  flex: 1;
  text-align: left;
}

.badge {
  font-family: var(--mono);
  font-size: 9.5px;
}

.row {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 6px;
  border-radius: 7px;
  transition: background var(--dur-fast) var(--ease);
}

.row:hover {
  background: var(--glass-strong);
}

.row.invalid {
  background: rgba(220, 38, 38, 0.07);
  box-shadow: inset 0 0 0 1px rgba(220, 38, 38, 0.35);
}

.swatch {
  position: relative;
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 5px;
  border: 1px solid var(--tint-12);
  overflow: hidden;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.4);
}

.swatch input {
  position: absolute;
  inset: 0;
  opacity: 0;
  border: none;
  padding: 0;
  cursor: pointer;
}

.number-dot {
  display: grid;
  place-items: center;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-faint);
  background: var(--tint-4);
  cursor: default;
}

.path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-size: 11.5px;
}

/* 行内改名：与路径同位，Enter/失焦提交，Esc 放弃 */
.path-edit {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 5px;
  border: 1px solid var(--accent-line);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font-size: 11px;
  font-family: var(--mono);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* 改名入口：悬停时露出的铅笔，双击路径也能改 */
.edit-path {
  flex: none;
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
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.row:hover .edit-path {
  opacity: 1;
}

.edit-path:hover {
  background: var(--tint-6);
  color: var(--text);
}

.value {
  flex: none;
  width: 92px;
  height: 23px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--tint-35);
  color: var(--text);
  font-size: 10.5px;
  text-align: right;
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}

.value:hover {
  border-color: var(--hairline);
}

.value:focus {
  border-color: var(--accent-line);
  background: var(--surface);
}

.mono {
  font-family: var(--mono);
}

.empty {
  margin: 18px 0;
  text-align: center;
  color: var(--text-faint);
  font-size: 11.5px;
}

.foot {
  border-top: 1px solid var(--hairline);
  padding-top: 8px;
}

.add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  height: 28px;
  border: 1px dashed var(--hairline-strong);
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}

.add:hover {
  background: var(--glass-strong);
  border-color: var(--accent-line);
  color: var(--text);
}

.add-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.add-line {
  display: flex;
  gap: 6px;
}

.path-input {
  flex: 1;
  min-width: 0;
}

.type {
  flex: none;
  width: 66px;
  padding: 0 4px;
}

.value-input {
  flex: 1;
  min-width: 0;
}

.path-input,
.value-input,
.type {
  height: 26px;
  border: 1px solid var(--hairline);
  border-radius: 7px;
  background: var(--tint-3);
  color: var(--text);
  font-size: 11px;
  font-family: inherit;
  padding: 0 7px;
  outline: none;
}

.value-input {
  font-family: var(--mono);
}

.path-input:focus,
.value-input:focus,
.type:focus {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.mini {
  flex: none;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--hairline);
  border-radius: 7px;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.mini:hover {
  background: var(--glass-strong);
  color: var(--text);
}

.mini.primary {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent);
}

.add-error {
  margin: 0;
  padding: 3px 6px;
  border-radius: 6px;
  background: rgba(220, 38, 38, 0.08);
  color: #b91c1c;
  font-size: 10.5px;
}
</style>
