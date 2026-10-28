<script setup lang="ts">
import { computed } from "vue";
import type { DocNode } from "@sqraft/core";
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

function setNum(key: "x" | "y" | "width" | "height", e: Event) {
  if (!node.value) return;
  dispatch({ type: "node.update", params: { nodeId: node.value.id, patch: { [key]: num(e) } } }, "inspect");
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

function setText(e: Event) {
  if (!node.value) return;
  dispatch({ type: "node.update", params: { nodeId: node.value.id, patch: { text: (e.target as HTMLInputElement).value } } }, "inspect");
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
  <div class="panel">
    <header><span class="micro-label">检查器</span></header>

    <template v-if="node && node.type !== 'page'">
      <section class="block">
        <div class="label-row"><span class="micro-label">位置与尺寸</span><span class="type-tag">{{ node.type }}</span></div>
        <div class="grid">
          <label>X</label><input class="mono" type="number" :value="node.x" @change="setNum('x', $event)" />
          <label>Y</label><input class="mono" type="number" :value="node.y" @change="setNum('y', $event)" />
          <label>W</label><input class="mono" type="number" :value="node.width" @change="setNum('width', $event)" />
          <label>H</label><input class="mono" type="number" :value="node.height" @change="setNum('height', $event)" />
        </div>
      </section>

      <section class="block">
        <span class="micro-label">外观</span>
        <div class="row">
          <label>填充</label>
          <select :value="fillTokenOf(node)" @change="setFillToken">
            <option value="">（无）</option>
            <option v-for="t in tokenNames" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <div class="row" v-if="node.type === 'rect' || node.type === 'frame'">
          <label>圆角</label>
          <input class="mono" type="number" :value="node.style.cornerRadius ?? 0" @change="setCornerRadius($event)" />
        </div>
      </section>

      <section class="block" v-if="node.type === 'text'">
        <span class="micro-label">文本</span>
        <div class="row"><label>文案</label><input :value="node.text" @change="setText($event)" /></div>
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

input,
select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  background: rgba(255, 255, 255, 0.045);
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
  background: rgba(255, 255, 255, 0.06);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.mono {
  font-family: var(--mono);
  font-size: 11.5px;
}

.seg {
  display: flex;
  gap: 2px;
  background: rgba(255, 255, 255, 0.04);
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
