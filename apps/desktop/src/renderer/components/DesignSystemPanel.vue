<script setup lang="ts">
/**
 * 设计系统面板：按路径前缀分组展示 Token，可改值、可新增、双击改名、可删除。
 * 所有写入都走命令（`token.define` / `token.rename` / `token.delete`，文档变更唯一入口，可撤销）；
 * 删除仍被引用的 Token 会先把引用冻结成字面量，并与删除包成同一条撤销。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  cloneGradientValue,
  isGradientValue,
  planTokenDelete,
  resolveGradient,
  tokenColorOf,
  tokenGradientOf,
  tokenNumberOf,
  tokenPathOf,
  tokenRefsOf,
  type GradientValue,
  type TokenDeletePlan,
  type TokenEntry,
} from "@sqraft/core";
import { dispatch, docStore, ui } from "../store";
import { t } from "../i18n";
import { localizeError } from "../errors";
import { tokenFocus } from "../token-focus";
import Icon from "./Icon.vue";
import GradientEditor from "./GradientEditor.vue";

interface Row {
  path: string;
  entry: TokenEntry;
}

const DEFAULT_GRADIENT: GradientValue = {
  type: "linear",
  from: { x: 0, y: 0.5 },
  to: { x: 1, y: 0.5 },
  stops: [
    { offset: 0, color: { value: "#6366f1" } },
    { offset: 1, color: { value: "#a855f7" } },
  ],
};

const filter = ref("");
/** 展开展示渐变编辑器的 Token 路径（行内编辑，一次改动一条 `token.define`）。 */
const editingGradient = ref<string | null>(null);
const draftGradient = ref<GradientValue>(cloneGradientValue(DEFAULT_GRADIENT));
const collapsed = ref<Record<string, boolean>>({});
const flashPath = ref<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | undefined;

// 从 ⌘K 跳过来：清过滤、展开分组、滚到该行并短暂高亮
watch(
  () => tokenFocus.rev,
  () => {
    const path = tokenFocus.path;
    if (!path) return;
    filter.value = "";
    collapsed.value[prefixOf(path)] = false;
    flashPath.value = path;
    void nextTick(() => {
      const row = document.querySelector(`[data-token-path="${CSS.escape(path)}"]`);
      row?.scrollIntoView({ block: "center" });
    });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      if (flashPath.value === path) flashPath.value = null;
    }, 1200);
  },
);

onBeforeUnmount(() => {
  clearTimeout(flashTimer);
  window.clearTimeout(invalidTimer);
});

function prefixOf(path: string): string {
  const i = path.indexOf("/");
  return i > 0 ? path.slice(0, i) : t("tokens.otherGroup");
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

/** Token 严格模式（ADR-0035）：文档级开关，只拦 agent 写入的字面量颜色。 */
const strict = computed(() => {
  void ui.version;
  return docStore.doc.strictTokens === true;
});

function onStrictChange(event: Event): void {
  const value = (event.target as HTMLInputElement).checked;
  dispatch({ type: "doc.setStrictTokens", params: { value } }, "strict-tokens");
}

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

/** 行内输入只服务颜色 / 数值；渐变行没有文本输入。 */
function commitRow(row: Row, raw: string): void {
  if (row.entry.type === "gradient") return;
  commit(row.path, row.entry.type, raw);
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

/* ---------- 渐变 Token ---------- */

const colorTokenPaths = computed(() => {
  void ui.version;
  return Object.keys(docStore.doc.tokens).filter((k) => docStore.doc.tokens[k]?.type === "color");
});

function gradientValueOf(entry: TokenEntry): GradientValue | undefined {
  return entry.type === "gradient" && isGradientValue(entry.value) ? entry.value : undefined;
}

/** 列表缩略条：线性按 from→to 求角度，径向按中心，角度用 conic，菱形按方向示意（只用于缩略）。 */
function gradientPreview(entry: TokenEntry): string {
  const value = gradientValueOf(entry);
  const resolved = value ? resolveGradient(docStore.doc, value) : undefined;
  if (!resolved) return "transparent";
  const stops = resolved.stops.map((stop) => `${stop.color} ${Math.round(stop.offset * 100)}%`).join(", ");
  if (resolved.type === "radial") {
    return `radial-gradient(circle at ${Math.round(resolved.from.x * 100)}% ${Math.round(resolved.from.y * 100)}%, ${stops})`;
  }
  if (resolved.type === "angular") return `conic-gradient(${stops})`;
  const dx = resolved.to.x - resolved.from.x;
  const dy = resolved.to.y - resolved.from.y;
  const angle = Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
  return `linear-gradient(${angle}deg, ${stops})`;
}

function toggleGradient(path: string): void {
  editingGradient.value = editingGradient.value === path ? null : path;
}

function setGradient(path: string, next: GradientValue): void {
  dispatch({ type: "token.define", params: { path, tokenType: "gradient", value: next } }, "token-edit");
}

/** 删除确认与占位展示：渐变显示成 `linear (3 stops)`，不显示 [object Object]。 */
function displayValue(entry: TokenEntry): string {
  const gradient = gradientValueOf(entry);
  return gradient ? `${gradient.type} (${gradient.stops.length} stops)` : String(entry.value);
}

/* ---------- 新增 ---------- */

const adding = ref(false);
const draft = ref({ path: "", type: "color" as TokenEntry["type"], value: "" });
const addError = ref("");

function startAdd(groupPrefix?: string) {
  adding.value = true;
  addError.value = "";
  draft.value = {
    path: groupPrefix ? `${groupPrefix}/` : "",
    type: groupPrefix === "gradient" ? "gradient" : groupPrefix === "color" ? "color" : groupPrefix ? "number" : "color",
    value: "",
  };
  draftGradient.value = cloneGradientValue(DEFAULT_GRADIENT);
}

/** 路径校验：新增与改名共用（至少两段、无空格/空段、不重复）。 */
function validatePath(path: string): string {
  if (!tokenPathOf(path)) return t("tokens.pathError");
  if (docStore.doc.tokens[path]) return t("tokens.pathExists");
  return "";
}

function submitAdd() {
  const path = draft.value.path.trim();
  const pathError = validatePath(path);
  if (pathError) {
    addError.value = pathError;
    return;
  }

  if (draft.value.type === "gradient") {
    const gradient = tokenGradientOf(draftGradient.value);
    if (!gradient) {
      addError.value = t("tokens.gradientInvalid");
      return;
    }
    dispatch({ type: "token.define", params: { path, tokenType: "gradient", value: gradient } }, "token-add");
    closeAddForm();
    return;
  }

  const value = draft.value.value.trim();
  if (draft.value.type === "color" ? !isValidColor(value) : !isValidNumber(value)) {
    addError.value = draft.value.type === "color" ? t("tokens.colorInvalid") : t("tokens.numberInvalid");
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
  closeAddForm();
}

function closeAddForm(): void {
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

/* ---------- 删除（有引用时先确认，删除会把引用冻结为字面量） ---------- */

const confirmingPath = ref<string | null>(null);

/**
 * 确认条文案：数字与取值现算，Token 被改名、撤销或外部删掉后不会显示过期信息。
 * O(nodes)，只在确认条打开且文档变更时算一次——不做额外缓存，缓存反而容易和文档不一致。
 */
const confirmText = computed(() => {
  void ui.version;
  const path = confirmingPath.value;
  if (!path) return "";
  const entry = docStore.doc.tokens[path];
  // Token 被别处删掉/撤销后行本身会消失；兜底是为了不渲染出「冻结为 」
  if (!entry) return t("tokens.deleteMissing");
  const plan = planTokenDelete(docStore.doc, path, true);
  const tokens = plan.status === "missing" ? [] : (plan.tokenRefs ?? []);
  const base = t("tokens.deleteConfirm", {
    count: tokenRefsOf(docStore.doc, path).length,
    value: displayValue(entry),
  });
  return tokens.length ? `${base}；${t("tokens.deleteConfirmTokens", { count: tokens.length })}` : base;
});

function requestDelete(path: string): void {
  // 两个行内态不同时开：在 A 行改名、点 B 行删除时，先把改名收掉
  if (renamingPath.value !== null) cancelRename();
  const plan = planTokenDelete(docStore.doc, path, false);
  if (plan.status === "missing") return;
  // 有引用（节点或渐变 Token）时不直接删：先把"会冻结成什么"摊开
  if (plan.status === "ready") {
    runPlan(path, plan);
    return;
  }
  // 有引用不直接删：先把"会冻结成什么值"摊开，避免一按就把设计系统脱钩
  confirmingPath.value = path;
}

function confirmDelete(path: string): void {
  const plan = planTokenDelete(docStore.doc, path, true);
  if (plan.status === "ready") runPlan(path, plan);
}

/** 冻结引用与删除 Token 必须是同一条撤销，否则撤销只回得来 Token、回不来 style。 */
function runPlan(path: string, plan: Extract<TokenDeletePlan, { status: "ready" }>): void {
  confirmingPath.value = null;
  if (renamingPath.value === path) cancelRename();
  void docStore
    .transact(t("tokens.delete"), () => {
      for (const cmd of plan.commands) dispatch(cmd);
    })
    // 引用里含锁定节点时命令会被拒绝：把原因摊到面板底部，别静默失败
    .catch((error: unknown) => {
      renameError.value = localizeError(error);
    });
}
</script>

<template>
  <div class="tokens">
    <header class="top">
      <input v-model="filter" class="search" :placeholder="t('tokens.searchPlaceholder')" spellcheck="false" />
      <span class="count">{{ total }}</span>
    </header>

    <label class="strict" :title="t('tokens.strictHint')">
      <input type="checkbox" :checked="strict" @change="onStrictChange" />
      <span>{{ t("tokens.strictLabel") }}</span>
    </label>

    <div class="list">
      <section v-for="g in groups" :key="g.prefix" class="group">
        <button class="group-head" @click="toggle(g.prefix)">
          <Icon name="chevron" :size="11" class="caret" :class="{ closed: collapsed[g.prefix] }" />
          <span class="prefix">{{ g.prefix }}</span>
          <span class="badge">{{ g.rows.length }}</span>
        </button>

        <template v-if="!collapsed[g.prefix]">
          <template v-for="row in g.rows" :key="row.path">
            <div
              class="row"
              :class="{ invalid: invalidPath === row.path, flash: flashPath === row.path }"
              :data-token-path="row.path"
              @dblclick="startRename(row.path)"
            >
              <label v-if="row.entry.type === 'color'" class="swatch" :style="{ background: String(row.entry.value) }">
                <input type="color" :value="hexOf(row.entry.value)" @change="onPick(row.path, $event)" />
              </label>
              <span
                v-else-if="row.entry.type === 'gradient'"
                class="swatch gradient-swatch"
                :style="{ background: gradientPreview(row.entry) }"
              />
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

              <button v-if="renamingPath !== row.path" class="edit-path" :title="t('tokens.renameHint')" @click="startRename(row.path)">
                <Icon name="pencil" :size="11" />
              </button>

              <button
                v-if="renamingPath !== row.path && row.entry.type === 'gradient'"
                class="value mono gradient-open"
                :class="{ on: editingGradient === row.path }"
                @click="toggleGradient(row.path)"
              >
                {{ t("tokens.editGradient") }}
              </button>
              <input
                v-else-if="renamingPath !== row.path"
                class="value mono"
                :value="row.entry.value"
                spellcheck="false"
                @change="commitRow(row, ($event.target as HTMLInputElement).value)"
              />

              <button
                v-if="renamingPath !== row.path"
                class="remove"
                :title="t('tokens.delete')"
                @click="requestDelete(row.path)"
                @dblclick.stop
              >
                <Icon name="close" :size="10" />
              </button>
            </div>

            <div v-if="editingGradient === row.path && gradientValueOf(row.entry)" class="gradient-inline">
              <GradientEditor
                :paint="gradientValueOf(row.entry)"
                :color-tokens="colorTokenPaths"
                @change="setGradient(row.path, $event)"
              />
            </div>

            <div v-if="confirmingPath === row.path" class="confirm">
              <span class="confirm-text">{{ confirmText }}</span>
              <button class="mini danger" @click="confirmDelete(row.path)">{{ t("common.delete") }}</button>
              <button class="mini" @click="confirmingPath = null">{{ t("common.cancel") }}</button>
            </div>
          </template>
        </template>
      </section>

      <p v-if="total === 0" class="empty">{{ t("tokens.empty") }}</p>
      <p v-else-if="groups.length === 0" class="empty">{{ t("tokens.noMatch") }}</p>
    </div>

    <footer class="foot">
      <p v-if="renameError" class="add-error">{{ renameError }}</p>
      <form v-if="adding" class="add-form" @submit.prevent="submitAdd">
        <div class="add-line">
          <input v-model="draft.path" class="path-input mono" placeholder="color/brand" spellcheck="false" autofocus />
          <select v-model="draft.type" class="type">
            <option value="color">{{ t("tokens.typeColor") }}</option>
            <option value="number">{{ t("tokens.typeNumber") }}</option>
            <option value="gradient">{{ t("tokens.typeGradient") }}</option>
          </select>
        </div>
        <div v-if="draft.type !== 'gradient'" class="add-line">
          <input v-model="draft.value" class="value-input mono" :placeholder="draft.type === 'color' ? '#3366ff' : '12'" spellcheck="false" />
          <button type="submit" class="mini primary">{{ t("common.add") }}</button>
          <button type="button" class="mini" @click="adding = false">{{ t("common.cancel") }}</button>
        </div>
        <template v-else>
          <GradientEditor :paint="draftGradient" :color-tokens="colorTokenPaths" @change="draftGradient = $event" />
          <div class="add-line">
            <button type="submit" class="mini primary">{{ t("common.add") }}</button>
            <button type="button" class="mini" @click="adding = false">{{ t("common.cancel") }}</button>
          </div>
        </template>
        <p v-if="addError" class="add-error">{{ addError }}</p>
      </form>
      <button v-else class="add" @click="startAdd()"><Icon name="plus" :size="12" />{{ t("tokens.add") }}</button>
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

.gradient-swatch {
  background-clip: padding-box;
}

.gradient-open {
  text-align: left;
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
}

.gradient-open.on {
  border-color: var(--accent-line);
  color: var(--text);
}

.gradient-inline {
  margin: 2px 0 6px 30px;
  padding: 6px 8px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--tint-3);
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

/* Token 严格模式（ADR-0035）：文档级开关，放在筛选栏正下方 */
.strict {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 5px 8px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--tint-3);
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}

.strict input {
  margin: 0;
  accent-color: var(--accent);
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

.row.flash {
  background: var(--tint-6, var(--glass-strong));
  box-shadow: inset 0 0 0 1px var(--accent, #6366f1);
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

/* 删除入口：和改名一样只在悬停时露出，避免误触 */
.remove {
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

.row:hover .remove {
  opacity: 1;
}

.remove:hover {
  background: rgba(220, 38, 38, 0.1);
  color: #b91c1c;
}

/* 有引用时的行内确认：说清"会冻结成什么"，别让人以为删了就没了 */
.confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px 6px;
}

.confirm-text {
  flex: 1;
  min-width: 0;
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.4;
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

.mini.danger {
  border-color: rgba(220, 38, 38, 0.35);
  background: rgba(220, 38, 38, 0.08);
  color: #b91c1c;
}

.mini.danger:hover {
  background: rgba(220, 38, 38, 0.14);
  color: #991b1b;
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
