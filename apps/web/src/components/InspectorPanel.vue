<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { findOuterOverrideOwner, findOverrideOwner, newId, type ComponentPropertyDef, type DocNode } from "@sqraft/core";
import { DEFAULT_TEXT_FONT_SIZE, measureTextSize } from "../text-metrics";
import { dispatch, docStore, hooks, ui } from "../store";

const node = computed<DocNode | null>(() => {
  void ui.version;
  const id = ui.selection[0];
  return id ? docStore.doc.nodes[id] ?? null : null;
});

const tokenNames = computed(() => {
  void ui.version;
  return Object.keys(docStore.doc.tokens);
});

const instanceOwner = computed(() => {
  void ui.version;
  const current = node.value;
  if (!current) return null;
  const info = findOverrideOwner(docStore.doc, current.id);
  if (!info) return null;
  return {
    instanceId: info.owner.id,
    isRoot: info.owner.id === current.id,
    count: Object.keys(info.owner.overrides ?? {}).length,
  };
});

function componentAncestorId(id: string): string | null {
  let cur = docStore.doc.nodes[id]?.parentId;
  while (cur) {
    const n = docStore.doc.nodes[cur];
    if (!n) return null;
    if (n.type === "component") return n.id;
    cur = n.parentId;
  }
  return null;
}

function hasSlotAncestor(id: string): boolean {
  let cur = docStore.doc.nodes[id]?.parentId;
  while (cur) {
    const n = docStore.doc.nodes[cur];
    if (!n) return false;
    if (n.type === "slot") return true;
    cur = n.parentId;
  }
  return false;
}

/** 主组件里的画板/分组可以转成插槽；实例内部与已有插槽祖先不允许。 */
const canMakeSlot = computed(() => {
  void ui.version;
  const n = node.value;
  if (!n || (n.type !== "frame" && n.type !== "group")) return false;
  if (!componentAncestorId(n.id)) return false;
  if (hasSlotAncestor(n.id)) return false;
  return !findOverrideOwner(docStore.doc, n.id);
});

function toSlot(): void {
  if (!node.value) return;
  try {
    dispatch({ type: "slot.create", params: { nodeId: node.value.id } }, "slot");
  } catch {
    /* 不满足约束时不改文档 */
  }
}

function clearSlot(): void {
  if (!node.value || node.value.type !== "slot") return;
  dispatch({ type: "slot.clear", params: { slotId: node.value.id } }, "slot-clear");
}

/* ---------- 组件属性 ---------- */

/** 选中节点所在的组件与可绑定的目标图层。 */
const componentContext = computed<{ component: DocNode; target: DocNode } | null>(() => {
  void ui.version;
  const current = node.value;
  if (!current) return null;
  if (current.type === "component") return { component: current, target: current };
  let component: DocNode | null = null;
  let cur = current.parentId ? docStore.doc.nodes[current.parentId] : undefined;
  while (cur) {
    if (cur.type === "component") {
      component = cur;
      break;
    }
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  if (!component) return null;
  // 实例内部与嵌套实例内部没有稳定的属性目标
  if (findOverrideOwner(docStore.doc, current.id)) return null;
  if (current.mainId && current.type !== "instance") return null;
  return { component, target: current };
});

function targetKey(target: DocNode): string {
  return target.type === "instance" ? target.id : (target.mainId ?? target.id);
}

const targetProp = computed<ComponentPropertyDef | null>(() => {
  const ctx = componentContext.value;
  if (!ctx) return null;
  return ctx.component.propertyDefs?.find((d) => d.targetMainId === targetKey(ctx.target)) ?? null;
});

const componentDefs = computed<ComponentPropertyDef[]>(() => {
  void ui.version;
  return node.value?.type === "component" ? (node.value.propertyDefs ?? []) : [];
});

const instanceProps = computed<{ instance: DocNode; defs: ComponentPropertyDef[] } | null>(() => {
  void ui.version;
  const current = node.value;
  if (!current || current.type !== "instance" || !current.componentId) return null;
  const component = docStore.doc.nodes[current.componentId];
  if (!component || component.type !== "component") return null;
  return { instance: current, defs: component.propertyDefs ?? [] };
});

const allComponents = computed(() => {
  void ui.version;
  return Object.values(docStore.doc.nodes)
    .filter((n) => n.type === "component")
    .map((n) => ({ id: n.id, name: n.name }));
});

function propTypeLabel(type: string): string {
  return type === "text" ? "文本" : type === "boolean" ? "布尔" : "实例替换";
}

function defineProp(type: "text" | "boolean" | "instance"): void {
  const ctx = componentContext.value;
  if (!ctx) return;
  try {
    dispatch(
      {
        type: "property.define",
        params: { componentId: ctx.component.id, targetMainId: ctx.target.id, id: newId(), type },
      },
      "property",
    );
  } catch {
    /* 不满足约束时不改文档 */
  }
}

function renameDef(def: ComponentPropertyDef, e: Event): void {
  const ctx = componentContext.value;
  if (!ctx) return;
  const input = e.target as HTMLInputElement;
  try {
    dispatch(
      { type: "property.rename", params: { componentId: ctx.component.id, propertyId: def.id, name: input.value } },
      "property",
    );
  } catch {
    input.value = def.name;
  }
}

function deleteDef(def: ComponentPropertyDef): void {
  const ctx = componentContext.value;
  if (!ctx) return;
  dispatch({ type: "property.delete", params: { componentId: ctx.component.id, propertyId: def.id } }, "property");
}

function propValue(def: ComponentPropertyDef): string | boolean {
  const info = instanceProps.value;
  if (!info) return "";
  const value = info.instance.propValues?.[def.id];
  if (value !== undefined) return value;
  const master = docStore.doc.nodes[def.targetMainId];
  if (def.type === "text") return master?.text ?? "";
  if (def.type === "boolean") return master?.visible ?? true;
  return master?.componentId ?? "";
}

function hasPropValue(def: ComponentPropertyDef): boolean {
  const info = instanceProps.value;
  return Boolean(info && info.instance.propValues?.[def.id] !== undefined);
}

function setProp(def: ComponentPropertyDef, value: string | boolean | null): void {
  const info = instanceProps.value;
  if (!info) return;
  try {
    dispatch(
      { type: "property.set", params: { instanceId: info.instance.id, propertyId: def.id, value } },
      "property",
    );
  } catch {
    /* 非法值不改文档 */
  }
}

function onTextProp(def: ComponentPropertyDef, e: Event): void {
  setProp(def, (e.target as HTMLInputElement).value);
}

function onBoolProp(def: ComponentPropertyDef, e: Event): void {
  setProp(def, (e.target as HTMLInputElement).checked);
}

function onSwapProp(def: ComponentPropertyDef, e: Event): void {
  const value = (e.target as HTMLSelectElement).value;
  setProp(def, value || null);
}

function onSwapComponent(e: Event): void {
  const info = instanceProps.value;
  if (!info) return;
  const componentId = (e.target as HTMLSelectElement).value;
  if (!componentId) return;
  try {
    dispatch(
      { type: "instance.swap", params: { instanceId: info.instance.id, componentId } },
      "instance-swap",
    );
  } catch {
    (e.target as HTMLSelectElement).value = info.instance.componentId ?? "";
  }
}

function gotoMaster(): void {
  const componentId = instanceProps.value?.instance.componentId;
  if (!componentId) return;
  let cur = docStore.doc.nodes[componentId];
  while (cur && cur.type !== "page") {
    cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : undefined;
  }
  if (cur) {
    ui.activePageId = cur.id;
    ui.expandedPageId = cur.id;
  }
  hooks.focusNode(componentId);
}

function detachInstance(): void {
  const info = instanceProps.value;
  if (!info) return;
  dispatch({ type: "component.detach", params: { instanceId: info.instance.id } }, "detach");
}

const overrideView = computed(() => {
  void ui.version;
  const current = node.value;
  if (!current) return null;
  const info = findOverrideOwner(docStore.doc, current.id);
  if (!info) return null;
  const patch = info.owner.overrides?.[info.key];
  if (!patch) return null;
  const fields: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key === "style") {
      for (const sk of Object.keys(value ?? {})) fields.push(`style.${sk}`);
    } else {
      fields.push(key);
    }
  }
  return fields.length ? { instanceId: info.owner.id, mainId: info.key, fields } : null;
});

const outerOverrideView = computed(() => {
  void ui.version;
  const current = node.value;
  if (!current || current.type !== "instance") return null;
  const info = findOuterOverrideOwner(docStore.doc, current.id);
  if (!info) return null;
  const patch = info.owner.overrides?.[info.key];
  if (!patch) return null;
  const fields = Object.keys(patch);
  return fields.length ? { instanceId: info.owner.id, mainId: info.key, fields } : null;
});

const FIELD_LABELS: Record<string, string> = {
  text: "文案",
  name: "名称",
  width: "宽",
  height: "高",
  x: "X",
  y: "Y",
  rotation: "旋转",
  visible: "可见性",
  locked: "锁定",
  layout: "布局",
  componentId: "组件",
  sides: "边数",
  vector: "路径",
  "style.fill": "填充",
  "style.stroke": "描边",
  "style.strokeWidth": "线宽",
  "style.cornerRadius": "圆角",
  "style.fontSize": "字号",
  "style.fontFamily": "字体",
  "style.fontWeight": "字重",
  "style.lineHeight": "行高",
  "style.textAlign": "对齐",
  propValues: "属性值",
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function resetField(field: string): void {
  const view = overrideView.value;
  if (!view) return;
  dispatch(
    {
      type: "instance.resetOverride",
      params: { instanceId: view.instanceId, mainId: view.mainId, fields: [field] },
    },
    "reset-override",
  );
}

function resetAllOverrides(): void {
  const owner = instanceOwner.value;
  if (!owner) return;
  dispatch({ type: "instance.resetOverride", params: { instanceId: owner.instanceId } }, "reset-override");
}

function resetOuterField(field: string): void {
  const view = outerOverrideView.value;
  if (!view) return;
  dispatch(
    {
      type: "instance.resetOverride",
      params: { instanceId: view.instanceId, mainId: view.mainId, fields: [field] },
    },
    "reset-override",
  );
}

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

      <section class="block" v-if="node.type === 'slot' || canMakeSlot">
        <span class="micro-label">插槽</span>
        <div v-if="canMakeSlot" class="row">
          <button class="mini wide" @click="toSlot">转为插槽</button>
        </div>
        <template v-else>
          <div class="row">
            <span class="muted">
              {{ instanceOwner ? (node.slotFilled ? "已填充实例内容" : "显示母版默认内容") : "母版默认内容" }}
            </span>
          </div>
          <div class="row" v-if="instanceOwner">
            <button class="mini wide" :disabled="!node.slotFilled" @click="clearSlot">清空插槽，恢复默认</button>
          </div>
          <div v-else class="row"><span class="muted">实例未填充时显示这些内容</span></div>
        </template>
      </section>

      <section class="block" v-if="node.type === 'component' || componentContext || instanceProps">
        <span class="micro-label">组件属性</span>

        <template v-if="node.type === 'component'">
          <div v-if="!componentDefs.length" class="row"><span class="muted">暂无属性；选中母版里的图层可创建</span></div>
          <div v-for="def in componentDefs" :key="def.id" class="prop-def">
            <input class="prop-name" :value="def.name" @change="renameDef(def, $event)" />
            <span class="muted">{{ propTypeLabel(def.type) }}</span>
            <span class="muted prop-target">{{ def.targetMainId === node.id ? "整个组件" : (docStore.doc.nodes[def.targetMainId]?.name ?? "—") }}</span>
            <button class="mini" @click="deleteDef(def)">删除</button>
          </div>
          <div class="row"><button class="mini wide" @click="defineProp('boolean')">创建布尔属性（整个组件可见性）</button></div>
        </template>

        <template v-else-if="componentContext">
          <div v-if="targetProp" class="row">
            <span class="muted">已是组件属性：{{ targetProp.name }}（{{ propTypeLabel(targetProp.type) }}）</span>
          </div>
          <template v-else>
            <div class="row" v-if="node.type === 'text'">
              <button class="mini wide" @click="defineProp('text')">创建文本属性</button>
            </div>
            <div class="row"><button class="mini wide" @click="defineProp('boolean')">创建布尔属性</button></div>
            <div class="row" v-if="node.type === 'instance'">
              <button class="mini wide" @click="defineProp('instance')">创建实例替换属性</button>
            </div>
          </template>
        </template>

        <template v-else-if="instanceProps">
          <div class="row">
            <label>组件</label>
            <select :value="instanceProps.instance.componentId ?? ''" @change="onSwapComponent">
              <option v-for="c in allComponents" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>
          <div class="row">
            <button class="mini" @click="gotoMaster">去主组件</button>
            <button class="mini" @click="detachInstance">脱离实例</button>
          </div>
          <div v-if="!instanceProps.defs.length" class="row"><span class="muted">该组件没有属性</span></div>
          <div v-for="def in instanceProps.defs" :key="def.id" class="row prop-row">
            <label>{{ def.name }}</label>
            <template v-if="def.type === 'text'">
              <input class="prop-input" type="text" :value="propValue(def)" @change="onTextProp(def, $event)" />
            </template>
            <template v-else-if="def.type === 'boolean'">
              <input type="checkbox" class="checkbox" :checked="propValue(def) === true" @change="onBoolProp(def, $event)" />
            </template>
            <template v-else>
              <select :value="String(propValue(def) ?? '')" @change="onSwapProp(def, $event)">
                <option v-for="c in allComponents" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </template>
            <button v-if="hasPropValue(def)" class="mini" @click="setProp(def, null)">重置</button>
          </div>
        </template>
      </section>

      <section class="block" v-if="outerOverrideView">
        <span class="micro-label">外层覆盖</span>
        <div v-for="f in outerOverrideView.fields" :key="f" class="row ovr-row">
          <label>{{ fieldLabel(f) }}</label>
          <button class="mini" @click="resetOuterField(f)">重置</button>
        </div>
      </section>

      <section class="block" v-if="instanceOwner">
        <span class="micro-label">实例覆盖</span>
        <div class="row">
          <span class="muted">{{ instanceOwner.isRoot ? "当前是实例根节点" : "位于实例内部" }}</span>
        </div>
        <div v-if="overrideView">
          <div v-for="f in overrideView.fields" :key="f" class="row ovr-row">
            <label>{{ fieldLabel(f) }}</label>
            <button class="mini" @click="resetField(f)">重置</button>
          </div>
        </div>
        <div v-else class="row">
          <span class="muted">当前图层没有覆盖</span>
        </div>
        <div class="row" v-if="instanceOwner.count">
          <button class="mini wide" @click="resetAllOverrides">重置全部覆盖（{{ instanceOwner.count }} 个图层）</button>
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

.muted {
  font-size: 11px;
  color: var(--text-faint);
}

.ovr-row {
  justify-content: space-between;
}

.mini {
  border: 1px solid var(--hairline);
  background: var(--glass-strong);
  color: var(--text-dim);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

.mini:hover {
  color: var(--text);
  border-color: var(--hairline-strong);
}

.mini.wide {
  width: 100%;
}

.prop-def {
  display: flex;
  align-items: center;
  gap: 6px;
}

.prop-name {
  width: 84px;
  flex: none;
}

.prop-target {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prop-row label {
  min-width: 52px;
}

.prop-input {
  flex: 1;
  min-width: 0;
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
