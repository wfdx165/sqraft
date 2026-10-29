<script setup lang="ts">
import { useInspector } from "../inspector/useInspector";
import { docStore, ui } from "../store";

const {
  lockedChain,
  targets,
  applyNodes,
  applyStyle,
  shared,
  fmt,
  numValue,
  num,
  boolOf,
  nameOf,
  typeLabel,
  setName,
  setNum,
  setRotation,
  setOpacity,
  toggleVisible,
  toggleLock,
  toggleClip,
  fillTokenOf,
  strokeTokenOf,
  colorOf,
  setFill,
  setStroke,
  resolvedCustom,
  setCustomPaint,
  setStrokeWidth,
  radiusOf,
  uniform,
  radiusUnified,
  setRadiusAll,
  setRadiusCorner,
  layoutOf,
  setLayout,
  addLayout,
  removeLayout,
  paddingOf,
  paddingUnified,
  setPaddingAll,
  setPaddingSide,
  setSizing,
  setMainAlign,
  setCrossAlign,
  setAlignContent,
  setSides,
  setLayoutNumber,
  toggleAbsolute,
  autoGrowTextArea,
  onTextAreaInput,
  onTextAreaKey,
  textPatch,
  commitText,
  applyTextStyle,
  setTextStyle,
  setAutoResize,
  setListType,
  setTruncate,
  canClosePath,
  setClosed,
  copyId,
  componentAncestorId,
  hasSlotAncestor,
  toSlot,
  clearSlot,
  targetKey,
  propTypeLabel,
  defineProp,
  renameDef,
  deleteDef,
  propValue,
  hasPropValue,
  setProp,
  onTextProp,
  onBoolProp,
  onSwapProp,
  onSwapComponent,
  gotoMaster,
  detachInstance,
  fieldLabel,
  resetField,
  resetAllOverrides,
  resetOuterField,
  MIXED,
  nodes,
  node,
  multi,
  allText,
  hasType,
  supportsFill,
  supportsStroke,
  supportsRadius,
  supportsClip,
  supportsLayout,
  supportsSizing,
  readonly,
  tokenNames,
  radiusExpanded,
  paddingExpanded,
  textDraft,
  textAreaEl,
  FONT_STACKS,
  copied,
  instanceOwner,
  canMakeSlot,
  componentContext,
  targetProp,
  componentDefs,
  instanceProps,
  allComponents,
  overrideView,
  outerOverrideView,
  FIELD_LABELS,
} = useInspector();
</script>

<template>
  <div class="panel" :data-version="ui.version">
    <header><span class="micro-label">检查器</span></header>

    <div v-if="ui.mode === 'pan'" class="empty">
      <p>拖动模式 · 浏览视图</p>
      <span>拖动画布查看页面；点「编辑」或按 V 回到编辑模式</span>
    </div>

    <template v-else-if="node">
      <section class="block meta">
        <div class="meta-row">
          <label>{{ multi ? "选区" : "名称" }}</label>
          <input v-if="!multi" class="name-input" :value="node.name" spellcheck="false" @change="setName" />
          <span v-else class="name-input mixed-text">已选 {{ nodes.length }} 个图层</span>
          <span class="type-tag">{{ multi ? "multi" : typeLabel(node) }}</span>
        </div>
        <div v-if="!multi" class="meta-row">
          <label>ID</label>
          <code class="node-id" :title="node.id">{{ node.id }}</code>
          <button class="copy" :class="{ on: copied }" title="复制 ID" @click="copyId">
            {{ copied ? "已复制" : "复制" }}
          </button>
        </div>
      </section>

      <section v-if="readonly" class="block">
        <div class="row">
          <span class="muted">该图层已锁定；解锁后才能编辑。</span>
          <button class="mini" @click="toggleLock">解锁</button>
        </div>
      </section>

      <section v-if="!multi" class="block">
        <div class="label-row">
          <span class="micro-label">位置与尺寸</span>
          <div class="icon-group">
            <button class="icon-btn" :class="{ off: !node.visible }" title="显示/隐藏" @click="toggleVisible">
              {{ node.visible ? "◉" : "○" }}
            </button>
            <button class="icon-btn" :class="{ on: node.locked }" title="锁定/解锁" @click="toggleLock">
              {{ node.locked ? "🔒" : "🔓" }}
            </button>
          </div>
        </div>
        <div class="grid">
          <label>X</label><input class="mono" type="number" :value="fmt(node.x)" :disabled="readonly" @change="setNum('x', $event)" />
          <label>Y</label><input class="mono" type="number" :value="fmt(node.y)" :disabled="readonly" @change="setNum('y', $event)" />
          <label>W</label>
          <div class="field-with-select">
            <input class="mono" type="number" :value="fmt(node.width)" :disabled="readonly || node.type === 'group'" @change="setNum('width', $event)" />
            <select
              v-if="supportsSizing || (node.layout && supportsLayout)"
              class="sizing"
              :value="node.layoutSizingW ?? 'fixed'"
              :disabled="readonly"
              @change="setSizing('W', $event)"
            >
              <option value="fixed">Fixed</option>
              <option value="hug">Hug</option>
              <option v-if="supportsSizing">Fill</option>
            </select>
          </div>
          <label>H</label>
          <div class="field-with-select">
            <input class="mono" type="number" :value="fmt(node.height)" :disabled="readonly || node.type === 'group'" @change="setNum('height', $event)" />
            <select
              v-if="supportsSizing || (node.layout && supportsLayout)"
              class="sizing"
              :value="node.layoutSizingH ?? 'fixed'"
              :disabled="readonly"
              @change="setSizing('H', $event)"
            >
              <option value="fixed">Fixed</option>
              <option value="hug">Hug</option>
              <option v-if="supportsSizing">Fill</option>
            </select>
          </div>
        </div>
        <div v-if="node.type !== 'page'" class="grid two">
          <label>旋转</label>
          <input class="mono" type="number" step="1" :value="fmt(node.rotation)" :disabled="readonly" @change="setRotation($event)" />
          <label>不透明度</label>
          <input class="mono" type="number" min="0" max="100" step="1" :value="Math.round((node.opacity ?? 1) * 100)" :disabled="readonly" @change="setOpacity($event)" />
        </div>
      </section>

      <section v-if="multi" class="block">
        <span class="micro-label">批量变换</span>
        <div class="grid two">
          <label>旋转</label>
          <input class="mono" type="number" step="1" :value="numValue(shared((n) => n.rotation))" placeholder="混合" :disabled="readonly" @change="setRotation($event)" />
          <label>不透明度</label>
          <input class="mono" type="number" min="0" max="100" step="1" :value="shared((n) => Math.round((n.opacity ?? 1) * 100)) === MIXED ? '' : String(shared((n) => Math.round((n.opacity ?? 1) * 100)))" placeholder="混合" :disabled="readonly" @change="setOpacity($event)" />
        </div>
        <div class="row">
          <button class="mini" :disabled="readonly" @click="applyNodes((n) => ({ visible: !n.visible }))">切换可见性</button>
          <button class="mini" :disabled="readonly" @click="applyNodes((n) => ({ locked: !n.locked }))">切换锁定</button>
        </div>
      </section>

      <!-- 子项布局：sizing 之外的最小/最大与绝对定位 -->
      <section v-if="!multi && supportsSizing" class="block">
        <span class="micro-label">布局项</span>
        <div class="row">
          <label>绝对定位</label>
          <input type="checkbox" class="checkbox" :checked="Boolean(node.layoutAbsolute)" :disabled="readonly" @change="toggleAbsolute" />
        </div>
        <div class="grid two" v-if="!node.layoutAbsolute">
          <label>最小 W</label>
          <input class="mono" type="number" :value="node.layoutMinW ?? ''" :disabled="readonly" @change="setLayoutNumber('layoutMinW', $event)" />
          <label>最小 H</label>
          <input class="mono" type="number" :value="node.layoutMinH ?? ''" :disabled="readonly" @change="setLayoutNumber('layoutMinH', $event)" />
          <label>最大 W</label>
          <input class="mono" type="number" :value="node.layoutMaxW ?? ''" :disabled="readonly" @change="setLayoutNumber('layoutMaxW', $event)" />
          <label>最大 H</label>
          <input class="mono" type="number" :value="node.layoutMaxH ?? ''" :disabled="readonly" @change="setLayoutNumber('layoutMaxH', $event)" />
        </div>
      </section>

      <!-- 自动布局容器 -->
      <section v-if="!multi && (supportsLayout || node.type === 'instance')" class="block">
        <div class="label-row">
          <span class="micro-label">自动布局</span>
          <button
            v-if="supportsLayout && !node.layout"
            class="mini"
            :disabled="readonly"
            @click="addLayout"
          >+ 添加</button>
          <button
            v-else-if="supportsLayout && node.layout"
            class="mini"
            :disabled="readonly"
            @click="removeLayout"
          >移除</button>
        </div>

        <template v-if="node.layout">
          <div class="seg">
            <button :class="{ on: node.layout.direction === 'horizontal' }" :disabled="readonly" @click="setLayout({ direction: 'horizontal' })">横向</button>
            <button :class="{ on: node.layout.direction === 'vertical' }" :disabled="readonly" @click="setLayout({ direction: 'vertical' })">纵向</button>
          </div>
          <div class="grid two">
            <label>间距</label>
            <input class="mono" type="number" :value="fmt(node.layout.gap)" :disabled="readonly" @change="setLayout({ gap: num($event) })" />
            <label>内边距</label>
            <div class="field-with-select">
              <input class="mono" type="number" :value="numValue(paddingUnified())" placeholder="混合" :disabled="readonly" @change="setPaddingAll" />
              <button class="mini corner-toggle" :disabled="readonly" @click="paddingExpanded = !paddingExpanded">
                {{ paddingExpanded ? "统一" : "分边" }}
              </button>
            </div>
          </div>
          <div v-if="paddingExpanded" class="grid two">
            <label>上</label><input class="mono" type="number" :value="fmt(paddingOf(node).top)" :disabled="readonly" @change="setPaddingSide('top', $event)" />
            <label>右</label><input class="mono" type="number" :value="fmt(paddingOf(node).right)" :disabled="readonly" @change="setPaddingSide('right', $event)" />
            <label>下</label><input class="mono" type="number" :value="fmt(paddingOf(node).bottom)" :disabled="readonly" @change="setPaddingSide('bottom', $event)" />
            <label>左</label><input class="mono" type="number" :value="fmt(paddingOf(node).left)" :disabled="readonly" @change="setPaddingSide('left', $event)" />
          </div>
          <div class="grid two">
            <label>主轴</label>
            <select :value="node.layout.mainAlign" :disabled="readonly" @change="setMainAlign">
              <option value="start">起始</option>
              <option value="center">居中</option>
              <option value="end">末尾</option>
              <option value="space-between">两端对齐</option>
            </select>
            <label>交叉轴</label>
            <select :value="node.layout.crossAlign" :disabled="readonly" @change="setCrossAlign">
              <option value="start">起始</option>
              <option value="center">居中</option>
              <option value="end">末尾</option>
              <option value="stretch">拉伸</option>
            </select>
          </div>
          <div class="row">
            <label>换行</label>
            <input type="checkbox" class="checkbox" :checked="node.layout.wrap" :disabled="readonly" @change="setLayout({ wrap: boolOf($event) })" />
            <label v-if="node.layout.wrap" class="inline-label">行距</label>
            <input v-if="node.layout.wrap" class="mono" type="number" :value="fmt(node.layout.crossGap)" :disabled="readonly" @change="setLayout({ crossGap: num($event) })" />
          </div>
          <div v-if="node.layout.wrap" class="grid two">
            <label>多行</label>
            <select :value="node.layout.alignContent" :disabled="readonly" @change="setAlignContent">
              <option value="start">起始</option>
              <option value="center">居中</option>
              <option value="end">末尾</option>
              <option value="space-between">两端对齐</option>
              <option value="stretch">拉伸</option>
            </select>
          </div>
        </template>
        <div v-else class="row"><span class="muted">未启用自动布局</span></div>
      </section>

      <!-- 文本 -->
      <section v-if="allText" class="block">
        <div class="label-row">
          <span class="micro-label">文本</span>
          <select class="inline-select" :value="node.textAutoResize ?? 'auto-width'" :disabled="readonly || multi" @change="setAutoResize">
            <option value="auto-width">自动宽度</option>
            <option value="auto-height">自动高度</option>
            <option value="fixed">固定尺寸</option>
          </select>
        </div>
        <div v-if="multi" class="row"><span class="muted">多选：排版改动会应用到全部文本图层</span></div>
        <div v-if="!multi" class="row text-row">
          <label>文案</label>
          <textarea
            ref="textAreaEl"
            class="text-area"
            rows="1"
            spellcheck="false"
            :value="textDraft"
            :disabled="readonly"
            @input="onTextAreaInput"
            @blur="commitText"
            @keydown="onTextAreaKey"
          />
        </div>
        <div class="grid two">
          <label>字体</label>
          <select :value="node.style.fontFamily ?? FONT_STACKS[0].value" :disabled="readonly" @change="setTextStyle('fontFamily', $event)">
            <option v-for="f in FONT_STACKS" :key="f.value" :value="f.value">{{ f.label }}</option>
          </select>
          <label>字重</label>
          <select :value="String(node.style.fontWeight ?? 400)" :disabled="readonly" @change="setTextStyle('fontWeight', $event, Number)">
            <option v-for="w in [100, 200, 300, 400, 500, 600, 700, 800, 900]" :key="w" :value="String(w)">{{ w }}</option>
          </select>
          <label>字号</label>
          <input class="mono" type="number" min="1" :value="fmt(node.style.fontSize ?? 20)" :disabled="readonly" @change="setTextStyle('fontSize', $event, Number)" />
          <label>行高</label>
          <div class="field-with-select">
            <input
              class="mono"
              type="number"
              :value="node.style.lineHeightUnit === 'auto' || !node.style.lineHeightUnit ? '' : fmt(node.style.lineHeight ?? 0)"
              placeholder="自动"
              :disabled="readonly || !node.style.lineHeightUnit || node.style.lineHeightUnit === 'auto'"
              @change="setTextStyle('lineHeight', $event, Number)"
            />
            <select :value="node.style.lineHeightUnit ?? 'auto'" :disabled="readonly" @change="setTextStyle('lineHeightUnit', $event)">
              <option value="auto">自动</option>
              <option value="px">px</option>
              <option value="percent">%</option>
            </select>
          </div>
          <label>字距</label>
          <div class="field-with-select">
            <input class="mono" type="number" :value="fmt(node.style.letterSpacing ?? 0)" :disabled="readonly" @change="setTextStyle('letterSpacing', $event, Number)" />
            <select :value="node.style.letterSpacingUnit ?? 'px'" :disabled="readonly" @change="setTextStyle('letterSpacingUnit', $event)">
              <option value="px">px</option>
              <option value="percent">%</option>
            </select>
          </div>
          <label>段距</label>
          <input class="mono" type="number" :value="fmt(node.style.paragraphSpacing ?? 0)" :disabled="readonly" @change="setTextStyle('paragraphSpacing', $event, Number)" />
        </div>
        <div class="row">
          <label>斜体</label>
          <input
            type="checkbox"
            class="checkbox"
            :checked="node.style.fontStyle === 'italic'"
            :disabled="readonly"
            @change="applyTextStyle({ fontStyle: boolOf($event) ? 'italic' : 'normal' })"
          />
          <label class="inline-label">截断</label>
          <input
            type="checkbox"
            class="checkbox"
            :checked="Boolean(node.truncate)"
            :disabled="readonly || (node.textAutoResize ?? 'auto-width') !== 'fixed'"
            @change="setTruncate"
          />
          <label class="inline-label">列表</label>
          <select class="inline-select" :value="node.listType ?? 'none'" :disabled="readonly" @change="setListType">
            <option value="none">无</option>
            <option value="bulleted">项目符号</option>
            <option value="numbered">编号</option>
          </select>
        </div>
        <div class="seg small">
          <button :class="{ on: (node.style.textAlign ?? 'left') === 'left' }" :disabled="readonly" @click="applyTextStyle({ textAlign: 'left' })">左</button>
          <button :class="{ on: node.style.textAlign === 'center' }" :disabled="readonly" @click="applyTextStyle({ textAlign: 'center' })">中</button>
          <button :class="{ on: node.style.textAlign === 'right' }" :disabled="readonly" @click="applyTextStyle({ textAlign: 'right' })">右</button>
          <button :class="{ on: node.style.textAlign === 'justify' }" :disabled="readonly" @click="applyTextStyle({ textAlign: 'justify' })">两端</button>
        </div>
        <div class="seg small">
          <button :class="{ on: (node.style.textVerticalAlign ?? 'top') === 'top' }" :disabled="readonly" @click="applyTextStyle({ textVerticalAlign: 'top' })">上</button>
          <button :class="{ on: node.style.textVerticalAlign === 'middle' }" :disabled="readonly" @click="applyTextStyle({ textVerticalAlign: 'middle' })">中</button>
          <button :class="{ on: node.style.textVerticalAlign === 'bottom' }" :disabled="readonly" @click="applyTextStyle({ textVerticalAlign: 'bottom' })">下</button>
        </div>
        <div class="grid two">
          <label>大小写</label>
          <select :value="node.style.textCase ?? 'none'" :disabled="readonly" @change="setTextStyle('textCase', $event)">
            <option value="none">无</option>
            <option value="upper">大写</option>
            <option value="lower">小写</option>
            <option value="title">标题</option>
          </select>
          <label>装饰</label>
          <select :value="node.style.textDecoration ?? 'none'" :disabled="readonly" @change="setTextStyle('textDecoration', $event)">
            <option value="none">无</option>
            <option value="underline">下划线</option>
            <option value="strikethrough">删除线</option>
          </select>
        </div>
      </section>

      <!-- 外观 -->
      <section v-if="supportsFill || supportsStroke" class="block">
        <span class="micro-label">外观</span>
        <div v-if="supportsFill" class="row">
          <label>填充</label>
          <div class="color-control">
            <span class="swatch" :style="{ background: colorOf(node.style.fill) }" />
            <select :value="fillTokenOf(node)" :disabled="readonly" @change="setFill">
              <option value="">（无）</option>
              <option value="__custom">自定义…</option>
              <option v-for="t in tokenNames" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
        </div>
        <div v-if="supportsFill && node.style.fill && !node.style.fill.token" class="row sub-row">
          <label />
          <input type="color" class="color-input" :value="colorOf(node.style.fill)" :disabled="readonly" @input="setCustomPaint('fill', $event)" />
          <input class="mono hex" :value="node.style.fill.value ?? ''" :disabled="readonly" @change="setCustomPaint('fill', $event)" />
        </div>
        <div v-if="supportsStroke" class="row">
          <label>描边</label>
          <div class="color-control">
            <span class="swatch" :style="{ background: colorOf(node.style.stroke) }" />
            <select :value="strokeTokenOf(node)" :disabled="readonly" @change="setStroke">
              <option value="">（无）</option>
              <option value="__custom">自定义…</option>
              <option v-for="t in tokenNames" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
        </div>
        <div v-if="supportsStroke && node.style.stroke && !node.style.stroke.token" class="row sub-row">
          <label />
          <input type="color" class="color-input" :value="colorOf(node.style.stroke)" :disabled="readonly" @input="setCustomPaint('stroke', $event)" />
          <input class="mono hex" :value="node.style.stroke.value ?? ''" :disabled="readonly" @change="setCustomPaint('stroke', $event)" />
        </div>
        <div v-if="supportsStroke" class="row">
          <label>线宽</label>
          <input class="mono" type="number" min="0" step="0.5" :value="node.style.strokeWidth ?? 1" :disabled="readonly" @change="setStrokeWidth($event)" />
        </div>
        <div v-if="supportsRadius" class="row">
          <label>圆角</label>
          <div class="field-with-select">
            <input class="mono" type="number" min="0" :value="numValue(radiusUnified())" placeholder="混合" :disabled="readonly" @change="setRadiusAll" />
            <button class="mini corner-toggle" :disabled="readonly" @click="radiusExpanded = !radiusExpanded">
              {{ radiusExpanded ? "统一" : "四角" }}
            </button>
          </div>
        </div>
        <div v-if="supportsRadius && radiusExpanded" class="grid two">
          <label>左上</label><input class="mono" type="number" min="0" :value="fmt(radiusOf(node).topLeft)" :disabled="readonly" @change="setRadiusCorner('topLeft', $event)" />
          <label>右上</label><input class="mono" type="number" min="0" :value="fmt(radiusOf(node).topRight)" :disabled="readonly" @change="setRadiusCorner('topRight', $event)" />
          <label>右下</label><input class="mono" type="number" min="0" :value="fmt(radiusOf(node).bottomRight)" :disabled="readonly" @change="setRadiusCorner('bottomRight', $event)" />
          <label>左下</label><input class="mono" type="number" min="0" :value="fmt(radiusOf(node).bottomLeft)" :disabled="readonly" @change="setRadiusCorner('bottomLeft', $event)" />
        </div>
        <div v-if="supportsClip" class="row">
          <label>裁剪内容</label>
          <input type="checkbox" class="checkbox" :checked="node.clip" :disabled="readonly" @change="toggleClip" />
        </div>
        <div v-if="!multi && node.type === 'path'" class="row">
          <label>闭合</label>
          <input type="checkbox" class="checkbox" :checked="Boolean(node.vector?.closed)" :disabled="readonly || !canClosePath(node)" @change="setClosed" />
        </div>
        <div v-if="!multi && node.type === 'polygon'" class="row">
          <label>边数</label>
          <input
            class="mono"
            type="number"
            min="3"
            max="12"
            step="1"
            :value="node.sides ?? 3"
            :disabled="readonly"
            @change="setSides"
          />
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
  gap: 8px;
}

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

.mixed-text {
  font-size: 12px;
  color: var(--text-dim);
  padding: 5px 0;
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

.inline-label {
  min-width: 0 !important;
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
  white-space: nowrap;
}

.mini:hover {
  color: var(--text);
  border-color: var(--hairline-strong);
}

.mini.wide {
  width: 100%;
}

.icon-group {
  display: flex;
  gap: 4px;
}

.icon-btn {
  border: 1px solid var(--hairline);
  background: transparent;
  border-radius: 6px;
  font-size: 11px;
  padding: 2px 6px;
  cursor: pointer;
}

.icon-btn.off {
  opacity: 0.45;
}

.icon-btn.on {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

.field-with-select {
  display: flex;
  gap: 4px;
  min-width: 0;
}

.field-with-select > input {
  flex: 1;
}

.field-with-select select {
  width: auto;
  flex: none;
  font-size: 10.5px;
  padding: 4px 4px;
}

.field-with-select .sizing {
  width: 62px;
}

.corner-toggle {
  flex: none;
}

.inline-select {
  width: auto !important;
  font-size: 11px;
  padding: 4px 6px;
}

.color-control {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.swatch {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1px solid var(--hairline-strong);
  flex: none;
}

.color-input {
  width: 32px !important;
  height: 26px;
  padding: 0 !important;
  border: none !important;
  background: transparent !important;
  flex: none;
}

.hex {
  flex: 1;
}

.sub-row {
  margin-left: 38px;
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

input:disabled,
select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mono {
  font-family: var(--mono);
  font-size: 11.5px;
}

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

.seg.small button {
  padding: 3px 6px;
  font-size: 11px;
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
