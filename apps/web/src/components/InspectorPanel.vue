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

const activeMode = computed(() => {
  void ui.version;
  return docStore.doc.activeMode;
});

function num(e: Event): number {
  return Number((e.target as HTMLInputElement).value);
}

function setNum(key: "x" | "y" | "width" | "height" | "rotation", e: Event) {
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

function setMode(e: Event) {
  dispatch({ type: "mode.set", params: { mode: (e.target as HTMLSelectElement).value } }, "mode");
}

function setLayout(patch: Record<string, unknown>) {
  if (!node.value || node.value.type !== "frame") return;
  const layout = { ...(node.value.layout ?? { direction: "horizontal", gap: 8, padding: 12, mainAlign: "start", crossAlign: "start" }), ...patch };
  dispatch({ type: "node.update", params: { nodeId: node.value.id, patch: { layout } } }, "layout");
}

function fillTokenOf(n: DocNode): string {
  return n.style.fill?.token ?? "";
}
</script>

<template>
  <div class="panel">
    <h3>检查器</h3>
    <div class="row">
      <label>模式</label>
      <select :value="activeMode" @change="setMode">
        <option v-for="m in docStore.doc.modes" :key="m" :value="m">{{ m }}</option>
      </select>
    </div>
    <template v-if="node && node.type !== 'page'">
      <div class="section">{{ node.name }}（{{ node.type }}）</div>
      <div class="grid">
        <label>X</label><input type="number" :value="node.x" @change="setNum('x', $event)" />
        <label>Y</label><input type="number" :value="node.y" @change="setNum('y', $event)" />
        <label>W</label><input type="number" :value="node.width" @change="setNum('width', $event)" />
        <label>H</label><input type="number" :value="node.height" @change="setNum('height', $event)" />
      </div>
      <div class="row">
        <label>填充 Token</label>
        <select :value="fillTokenOf(node)" @change="setFillToken">
          <option value="">（无）</option>
          <option v-for="t in tokenNames" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>
      <div class="row" v-if="node.type === 'rect' || node.type === 'frame'">
        <label>圆角</label>
        <input type="number" :value="node.style.cornerRadius ?? 0" @change="setCornerRadius($event)" />
      </div>
      <template v-if="node.type === 'text'">
        <div class="row"><label>文案</label><input :value="node.text" @change="setText($event)" /></div>
        <div class="row"><label>字号</label><input type="number" :value="node.style.fontSize ?? 14" @change="setFontSize($event)" /></div>
      </template>
      <template v-if="node.type === 'frame'">
        <div class="section">自动布局</div>
        <div class="row">
          <label>方向</label>
          <select :value="node.layout?.direction ?? 'horizontal'" @change="setLayout({ direction: ($event.target as HTMLSelectElement).value })">
            <option value="horizontal">横向</option>
            <option value="vertical">纵向</option>
          </select>
        </div>
        <div class="grid">
          <label>间距</label><input type="number" :value="node.layout?.gap ?? 8" @change="setLayout({ gap: num($event) })" />
          <label>内边距</label><input type="number" :value="node.layout?.padding ?? 12" @change="setLayout({ padding: num($event) })" />
        </div>
      </template>
    </template>
    <div v-else class="empty">选中节点后编辑属性</div>
  </div>
</template>

<style scoped>
.panel { padding: 8px 10px; }
h3 { font-size: 12px; color: #666; margin: 0 0 8px; }
.section { font-size: 11px; color: #888; margin: 12px 0 6px; border-top: 1px solid #eee; padding-top: 10px; }
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.row label { font-size: 11px; color: #666; min-width: 56px; }
.grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; margin-bottom: 8px; align-items: center; }
.grid label { font-size: 11px; color: #666; }
input, select { border: 1px solid #d5d5da; border-radius: 4px; padding: 3px 6px; font-size: 12px; width: 100%; box-sizing: border-box; background: #fff; }
.empty { font-size: 12px; color: #999; }
</style>
