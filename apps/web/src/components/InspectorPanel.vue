<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DocNode } from "@sqraft/core";
import { DEFAULT_TEXT_FONT_SIZE, measureTextSize } from "../text-metrics";
import { dispatch, docStore, ui } from "../store";

const node = computed<DocNode | null>(() => {
  void ui.version;
  const id = ui.selection[0];
  return id ? docStore.doc.nodes[id] ?? null : null;
});

const tokenNames = computed(() => {
  void ui.version;
  return Object.keys(docStore.doc.tokens);
});

function num(e: Event): number {
  return Number((e.target as HTMLInputElement).value);
}

/** 类型标签：多边形的叫法跟着边数走（三角形 / 多边形），其余直接显示节点类型。 */
function typeLabel(n: DocNode): string {
  if (n.type === "polygon") return (n.sides ?? 3) === 3 ? "三角形" : "多边形";
  return n.type;
}

function setSides(e: Event) {
  if (!node.value) return;
  const raw = Math.round(num(e));
  if (!Number.isFinite(raw)) return;
  const sides = Math.max(3, Math.min(12, raw));
  dispatch({ type: "node.update", params: { nodeId: node.value.id, patch: { sides } } }, "inspect");
}

function setNum(key: "x" | "y" | "width" | "height", e: Event) {
  if (!node.value) return;
  dispatch({ type: "node.update", params: { nodeId: node.value.id, patch: { [key]: num(e) } } }, "inspect");
}

/** 只做展示层舍入：文档保留完整精度（缩放会把 400 算成 399.99999999999994）。 */
function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function setCornerRadius(e: Event) {
  if (!node.value) return;
  dispatch(
    { type: "node.update", params: { nodeId: node.value.id, patch: { style: { ...node.value.style, cornerRadius: num(e) } } } },
    "inspect",
  );
}

function setFillToken(e: Event) {
  if (!node.value) return;
  const token = (e.target as HTMLSelectElement).value;
  const fill = token ? { token } : null;
  dispatch(
    { type: "node.update", params: { nodeId: node.value.id, patch: { style: { ...node.value.style, fill } } } },
    "inspect",
  );
}

function strokeTokenOf(n: DocNode): string {
  return n.style.stroke?.token ?? "";
}

function setStrokeToken(e: Event) {
  if (!node.value) return;
  const token = (e.target as HTMLSelectElement).value;
  const stroke = token ? { token } : undefined;
  dispatch(
    { type: "node.update", params: { nodeId: node.value.id, patch: { style: { ...node.value.style, stroke } } } },
    "inspect",
  );
}

function setStrokeWidth(e: Event) {
  if (!node.value) return;
  dispatch(
    {
      type: "node.update",
      params: { nodeId: node.value.id, patch: { style: { ...node.value.style, strokeWidth: Math.max(0, num(e)) } } },
    },
    "inspect",
  );
}

function canClosePath(n: DocNode): boolean {
  return Boolean(n.vector?.closed) || (n.vector?.anchors.length ?? 0) >= 3;
}

function setClosed(e: Event) {
  const n = node.value;
  if (!n?.vector) return;
  const closed = (e.target as HTMLInputElement).checked;
  if (closed && n.vector.anchors.length < 3) return;
  dispatch(
    { type: "node.update", params: { nodeId: n.id, patch: { vector: { ...n.vector, closed } } } },
    "inspect",
  );
}

function setName(e: Event) {
  if (!node.value) return;
  const name = (e.target as HTMLInputElement).value.replace(/\s+/g, " ").trim();
  if (!name || name === node.value.name) return;
  dispatch({ type: "node.update", params: { nodeId: node.value.id, patch: { name } } }, "rename-node");
}

/* ---------- 文案：多行草稿，失焦 / ⌘Enter 提交，Esc 放弃 ---------- */

const textDraft = ref("");
const textAreaEl = ref<HTMLTextAreaElement | null>(null);

watch(
  node,
  (n) => {
    textDraft.value = n?.text ?? "";
    requestAnimationFrame(() => autoGrowTextArea(textAreaEl.value));
  },
  { immediate: true },
);

function autoGrowTextArea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}

function commitText() {
  const n = node.value;
  if (!n) return;
  const text = textDraft.value;
  if (text === (n.text ?? "")) return;
  // 文本尺寸跟着内容走（与画布行内编辑同一套测量）
  const size = measureTextSize(text, n.style.fontSize ?? DEFAULT_TEXT_FONT_SIZE, n.style.fontFamily);
  dispatch(
    { type: "node.update", params: { nodeId: n.id, patch: { text, width: size.width, height: size.height } } },
    "inspect",
  );
}

function onTextAreaInput(e: Event) {
  const el = e.target as HTMLTextAreaElement;
  textDraft.value = el.value;
  autoGrowTextArea(el);
}

function onTextAreaKey(e: KeyboardEvent) {
  if (e.isComposing) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    commitText();
    (e.target as HTMLTextAreaElement).blur();
  } else if (e.key === "Escape") {
    e.preventDefault();
    textDraft.value = node.value?.text ?? "";
    (e.target as HTMLTextAreaElement).blur();
  }
}

const copied = ref(false);
let copyTimer = 0;

async function copyId() {
  if (!node.value) return;
  try {
    await navigator.clipboard.writeText(node.value.id);
    copied.value = true;
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => (copied.value = false), 1200);
  } catch {
    /* 剪贴板不可用时静默失败 */
  }
}

function setFontSize(e: Event) {
  if (!node.value) return;
  dispatch(
    { type: "node.update", params: { nodeId: node.value.id, patch: { style: { ...node.value.style, fontSize: num(e) } } } },
    "inspect",
  );
}

function setLayout(patch: Record<string, unknown>) {
  if (!node.value || node.value.type !== "frame") return;
  const layout = {
    ...(node.value.layout ?? { direction: "horizontal", gap: 8, padding: 12, mainAlign: "start", crossAlign: "start" }),
    ...patch,
  };
  dispatch({ type: "node.update", params: { nodeId: node.value.id, patch: { layout } } }, "layout");
}

function fillTokenOf(n: DocNode): string {
  return n.style.fill?.token ?? "";
}
</script>

<template>
  <!-- data-version：命令在文档里原地改字段，computed 返回同一对象引用不会触发重渲染，
       这里让根节点跟随版本号，保证检查器数值永远是当前文档的 -->
  <div class="panel" :data-version="ui.version">
    <header><span class="micro-label">检查器</span></header>

    <div v-if="ui.mode === 'pan'" class="empty">
      <p>拖动模式 · 浏览视图</p>
      <span>拖动画布查看页面；点「编辑」或按 V 回到编辑模式</span>
    </div>

    <template v-else-if="node">
      <section class="block meta">
        <div class="meta-row">
          <label>名称</label>
          <input class="name-input" :value="node.name" spellcheck="false" @change="setName" />
          <span class="type-tag">{{ typeLabel(node) }}</span>
        </div>
        <div class="meta-row">
          <label>ID</label>
          <code class="node-id" :title="node.id">{{ node.id }}</code>
          <button class="copy" :class="{ on: copied }" title="复制 ID" @click="copyId">
            {{ copied ? "已复制" : "复制" }}
          </button>
        </div>
      </section>

      <section class="block">
        <div class="label-row"><span class="micro-label">位置与尺寸</span></div>
        <div class="grid">
          <label>X</label><input class="mono" type="number" :value="fmt(node.x)" @change="setNum('x', $event)" />
          <label>Y</label><input class="mono" type="number" :value="fmt(node.y)" @change="setNum('y', $event)" />
          <label>W</label><input class="mono" type="number" :value="fmt(node.width)" @change="setNum('width', $event)" />
          <label>H</label><input class="mono" type="number" :value="fmt(node.height)" @change="setNum('height', $event)" />
        </div>
      </section>

      <section class="block" v-if="node.type !== 'page'">
        <span class="micro-label">外观</span>
        <div class="row">
          <label>填充</label>
          <select :value="fillTokenOf(node)" @change="setFillToken">
            <option value="">（无）</option>
            <option v-for="t in tokenNames" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <div class="row">
          <label>描边</label>
          <select :value="strokeTokenOf(node)" @change="setStrokeToken">
            <option value="">（无）</option>
            <option v-for="t in tokenNames" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <div class="row">
          <label>线宽</label>
          <input class="mono" type="number" min="0" step="0.5" :value="node.style.strokeWidth ?? 1" @change="setStrokeWidth($event)" />
        </div>
        <div class="row" v-if="node.type === 'path'">
          <label>闭合</label>
          <input
            class="checkbox"
            type="checkbox"
            :checked="Boolean(node.vector?.closed)"
            :disabled="!canClosePath(node)"
            @change="setClosed"
          />
        </div>
        <div class="row" v-if="node.type === 'polygon'">
          <label>边数</label>
          <input class="mono" type="number" min="3" max="12" step="1" :value="node.sides ?? 3" @change="setSides" />
        </div>
        <div class="row" v-if="node.type === 'rect' || node.type === 'frame'">
          <label>圆角</label>
          <input class="mono" type="number" :value="node.style.cornerRadius ?? 0" @change="setCornerRadius($event)" />
        </div>
      </section>

      <section class="block" v-if="node.type === 'text'">
        <span class="micro-label">文本</span>
        <div class="row text-row">
          <label>文案</label>
          <textarea
            ref="textAreaEl"
            class="text-area"
            rows="1"
            spellcheck="false"
            :value="textDraft"
            @input="onTextAreaInput"
            @blur="commitText"
            @keydown="onTextAreaKey"
          />
        </div>
        <div class="row"><label>字号</label><input class="mono" type="number" :value="node.style.fontSize ?? 14" @change="setFontSize($event)" /></div>
      </section>

      <section class="block" v-if="node.type === 'frame'">
        <span class="micro-label">自动布局</span>
        <div class="seg">
          <button :class="{ on: (node.layout?.direction ?? 'horizontal') === 'horizontal' }" @click="setLayout({ direction: 'horizontal' })">横向</button>
          <button :class="{ on: node.layout?.direction === 'vertical' }" @click="setLayout({ direction: 'vertical' })">纵向</button>
        </div>
        <div class="grid two">
          <label>间距</label><input class="mono" type="number" :value="node.layout?.gap ?? 8" @change="setLayout({ gap: num($event) })" />
          <label>内边距</label><input class="mono" type="number" :value="node.layout?.padding ?? 12" @change="setLayout({ padding: num($event) })" />
        </div>
      </section>
    </template>

    <div v-else class="empty">
      <p>未选中节点</p>
      <span>选中画布对象以编辑属性</span>
    </div>
  </div>
</template>

<style scoped>
.panel {
  padding: 12px 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
}

header {
  padding: 0 2px 10px;
}

.block {
  padding: 12px 2px;
  border-top: 1px solid var(--hairline);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.block:first-of-type {
  border-top: none;
  padding-top: 2px;
}

.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* 名称 / ID 元信息：所有选中对象（含页面）统一展示 */
.meta {
  gap: 6px;
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.meta-row label {
  flex: none;
  min-width: 30px;
  font-size: 11px;
  color: var(--text-faint);
}

.name-input {
  flex: 1;
}

.node-id {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-dim);
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
}

.copy {
  flex: none;
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-faint);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: 10.5px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}

.copy:hover {
  background: rgba(15, 23, 42, 0.05);
  color: var(--text);
}

.copy.on {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

.type-tag {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--text-faint);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
  padding: 1px 7px;
  text-transform: lowercase;
}

.grid {
  display: grid;
  grid-template-columns: 16px 1fr 16px 1fr;
  gap: 6px 8px;
  align-items: center;
}

.grid.two {
  grid-template-columns: 44px 1fr;
}

.grid label {
  font-size: 11px;
  color: var(--text-faint);
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row label {
  font-size: 11px;
  color: var(--text-faint);
  min-width: 30px;
}

input.checkbox {
  width: 14px;
  height: 14px;
  padding: 0;
  accent-color: var(--accent);
  flex: none;
}

input,
select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 5px 8px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}

input:hover,
select:hover {
  border-color: var(--hairline-strong);
}

input:focus,
select:focus {
  border-color: var(--accent-line);
  background: rgba(15, 23, 42, 0.05);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.mono {
  font-family: var(--mono);
  font-size: 11.5px;
}

/* 多行文案：与 input 同款外观，自动增高 */
.text-row {
  align-items: flex-start;
}

.text-area {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  min-height: 30px;
  max-height: 132px;
  resize: none;
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 5px 8px;
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
  outline: none;
  overflow-y: auto;
  transition:
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}

.text-area:focus {
  border-color: var(--accent-line);
  background: rgba(15, 23, 42, 0.05);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.seg {
  display: flex;
  gap: 2px;
  background: rgba(15, 23, 42, 0.035);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
  padding: 2px;
}

.seg button {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: var(--radius-pill);
  padding: 4px 10px;
  font-size: 11.5px;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.seg button:hover {
  color: var(--text);
}

.seg button.on {
  background: var(--glass-strong);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}

.empty {
  margin-top: 12px;
  padding: 40px 12px;
  text-align: center;
  color: var(--text-faint);
}

.empty p {
  margin: 0 0 6px;
  color: var(--text-dim);
  font-size: 12.5px;
}

.empty span {
  font-size: 11px;
}
</style>
