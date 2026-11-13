<script setup lang="ts">
import { useInspector } from "../inspector/useInspector";
import Icon from "./Icon.vue";
import ImageSection from "./ImageSection.vue";
import TokenLink from "./TokenLink.vue";
import { EFFECT_TYPES } from "@sqraft/core";
import { docStore, ui } from "../store";
import { t } from "../i18n";

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
  supportsEffects,
  effectsOf,
  effectLabel,
  isShadowEffectOf,
  shadowColorOf,
  addEffect,
  removeEffect,
  toggleEffect,
  setEffectNumber,
  setEffectColorToken,
  setEffectColorValue,
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
  importedFamilies,
  weightOptions,
  fontInput,
  importFont,
  backgroundInput,
  setBackgroundImage,
  setBackgroundFit,
  clearBackgroundImage,
  selectionBounds,
  setBoundsNumber,
  showAlign,
  canAlign,
  canDistribute,
  align,
  distribute,
  tokenNames,
  styleView,
  layoutView,
  scalarTokenOf,
  cornerTokenOf,
  allCornerToken,
  paddingTokenOf,
  allPaddingToken,
  layoutTokenOf,
  openScalarToken,
  openCornerToken,
  openPaddingToken,
  openLayoutToken,
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
  inspectorTab,
  setInspectorTab,
  link,
  extraLinkCount,
  linkPages,
  linkTargetValue,
  linkBlocked,
  setLinkTarget,
  setLinkTransition,
  setLinkDuration,
  removeLink,
  setScrollDirection,
} = useInspector();
</script>

<template>
  <div class="panel" :data-version="ui.version">
    <header><span class="micro-label">{{ t("inspector.title") }}</span></header>

    <div v-if="ui.mode === 'pan'" class="empty">
      <p>{{ t("inspector.browseMode") }}</p>
      <span>{{ t("inspector.browseHint") }}</span>
    </div>

    <template v-else>
      <div class="tabs seg small">
        <button :class="{ on: inspectorTab === 'design' }" @click="setInspectorTab('design')">{{ t("inspector.tabDesign") }}</button>
        <button :class="{ on: inspectorTab === 'prototype' }" @click="setInspectorTab('prototype')">{{ t("inspector.tabPrototype") }}</button>
      </div>

      <template v-if="inspectorTab === 'design'">
    <template v-if="node">
      <section class="block meta">
        <div class="meta-row">
          <label>{{ multi ? t("inspector.selection") : t("inspector.name") }}</label>
          <input v-if="!multi" class="name-input" :value="node.name" spellcheck="false" @change="setName" />
          <span v-else class="name-input mixed-text">{{ t("inspector.selectedLayers", { count: nodes.length }) }}</span>
          <span class="type-tag">{{ multi ? "multi" : typeLabel(node) }}</span>
        </div>
        <div v-if="!multi" class="meta-row">
          <label>ID</label>
          <code class="node-id" :title="node.id">{{ node.id }}</code>
          <button class="copy" :class="{ on: copied }" :title="t('inspector.copyId')" @click="copyId">
            {{ copied ? t("common.copied") : t("common.copy") }}
          </button>
        </div>
      </section>

      <ImageSection v-if="!multi && node.type === 'image'" :node="node" />

      <section v-if="readonly" class="block">
        <div class="row">
          <span class="muted">{{ t("inspector.lockedHint") }}</span>
          <button class="mini" @click="toggleLock">{{ t("inspector.unlock") }}</button>
        </div>
      </section>

      <section v-if="!multi" class="block">
        <div class="label-row">
          <span class="micro-label">{{ t("inspector.positionSize") }}</span>
          <div class="icon-group">
            <button class="icon-btn" :class="{ off: !node.visible }" :title="t('inspector.showHide')" @click="toggleVisible">
              {{ node.visible ? "◉" : "○" }}
            </button>
            <button class="icon-btn" :class="{ on: node.locked }" :title="t('inspector.lockUnlock')" @click="toggleLock">
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
          <label>{{ t("inspector.rotation") }}</label>
          <input class="mono" type="number" step="1" :value="fmt(node.rotation)" :disabled="readonly" @change="setRotation($event)" />
          <label>{{ t("inspector.opacity") }}</label>
          <input class="mono" type="number" min="0" max="100" step="1" :value="Math.round((node.opacity ?? 1) * 100)" :disabled="readonly" @change="setOpacity($event)" />
        </div>
      </section>

      <!-- 对齐与分布：单选对齐父内容区、多选对齐选区包围盒；自动布局子项置灰 -->
      <section v-if="showAlign" class="block">
        <span class="micro-label">{{ t("inspector.align") }}</span>
        <div class="align-row">
          <button class="icon-btn" :disabled="!canAlign" :title="t('inspector.alignLeft')" @click="align('left')"><Icon name="align-left" :size="14" /></button>
          <button class="icon-btn" :disabled="!canAlign" :title="t('inspector.alignHCenter')" @click="align('h-center')"><Icon name="align-h-center" :size="14" /></button>
          <button class="icon-btn" :disabled="!canAlign" :title="t('inspector.alignRight')" @click="align('right')"><Icon name="align-right" :size="14" /></button>
          <button class="icon-btn" :disabled="!canAlign" :title="t('inspector.alignTop')" @click="align('top')"><Icon name="align-top" :size="14" /></button>
          <button class="icon-btn" :disabled="!canAlign" :title="t('inspector.alignVCenter')" @click="align('v-center')"><Icon name="align-v-center" :size="14" /></button>
          <button class="icon-btn" :disabled="!canAlign" :title="t('inspector.alignBottom')" @click="align('bottom')"><Icon name="align-bottom" :size="14" /></button>
          <button class="icon-btn" :disabled="!canDistribute" :title="t('inspector.distributeH')" @click="distribute('horizontal')"><Icon name="distribute-h" :size="14" /></button>
          <button class="icon-btn" :disabled="!canDistribute" :title="t('inspector.distributeV')" @click="distribute('vertical')"><Icon name="distribute-v" :size="14" /></button>
        </div>
        <p v-if="!canAlign" class="hint">{{ t("inspector.autoAlignHint") }}</p>
      </section>

      <section v-if="multi" class="block">
        <span class="micro-label">{{ t("inspector.batch") }}</span>
        <!-- 包围盒语义：X/Y 平移整体，W/H 等比缩放整体 -->
        <div class="grid two" v-if="selectionBounds">
          <label>X</label>
          <input class="mono" type="number" step="1" :value="fmt(selectionBounds.x)" :disabled="readonly" @change="setBoundsNumber('x', $event)" />
          <label>Y</label>
          <input class="mono" type="number" step="1" :value="fmt(selectionBounds.y)" :disabled="readonly" @change="setBoundsNumber('y', $event)" />
          <label>W</label>
          <input class="mono" type="number" step="1" :value="fmt(selectionBounds.width)" :disabled="readonly" @change="setBoundsNumber('w', $event)" />
          <label>H</label>
          <input class="mono" type="number" step="1" :value="fmt(selectionBounds.height)" :disabled="readonly" @change="setBoundsNumber('h', $event)" />
        </div>
        <div class="grid two">
          <label>{{ t("inspector.rotation") }}</label>
          <input class="mono" type="number" step="1" :value="numValue(shared((n) => n.rotation))" :placeholder="t('inspector.mixed')" :disabled="readonly" @change="setRotation($event)" />
          <label>{{ t("inspector.opacity") }}</label>
          <input class="mono" type="number" min="0" max="100" step="1" :value="shared((n) => Math.round((n.opacity ?? 1) * 100)) === MIXED ? '' : String(shared((n) => Math.round((n.opacity ?? 1) * 100)))" :placeholder="t('inspector.mixed')" :disabled="readonly" @change="setOpacity($event)" />
        </div>
        <div class="row">
          <button class="mini" :disabled="readonly" @click="applyNodes((n) => ({ visible: !n.visible }))">{{ t("inspector.toggleVisible") }}</button>
          <button class="mini" :disabled="readonly" @click="applyNodes((n) => ({ locked: !n.locked }))">{{ t("inspector.toggleLock") }}</button>
        </div>
      </section>

      <!-- 子项布局：sizing 之外的最小/最大与绝对定位 -->
      <section v-if="!multi && supportsSizing" class="block">
        <span class="micro-label">{{ t("inspector.layoutItem") }}</span>
        <div class="row">
          <label>{{ t("inspector.absolute") }}</label>
          <input type="checkbox" class="checkbox" :checked="Boolean(node.layoutAbsolute)" :disabled="readonly" @change="toggleAbsolute" />
        </div>
        <div class="grid two" v-if="!node.layoutAbsolute">
          <label>{{ t("inspector.minW") }}</label>
          <input class="mono" type="number" :value="node.layoutMinW ?? ''" :disabled="readonly" @change="setLayoutNumber('layoutMinW', $event)" />
          <label>{{ t("inspector.minH") }}</label>
          <input class="mono" type="number" :value="node.layoutMinH ?? ''" :disabled="readonly" @change="setLayoutNumber('layoutMinH', $event)" />
          <label>{{ t("inspector.maxW") }}</label>
          <input class="mono" type="number" :value="node.layoutMaxW ?? ''" :disabled="readonly" @change="setLayoutNumber('layoutMaxW', $event)" />
          <label>{{ t("inspector.maxH") }}</label>
          <input class="mono" type="number" :value="node.layoutMaxH ?? ''" :disabled="readonly" @change="setLayoutNumber('layoutMaxH', $event)" />
        </div>
      </section>

      <!-- 自动布局容器 -->
      <section v-if="!multi && (supportsLayout || node.type === 'instance')" class="block">
        <div class="label-row">
          <span class="micro-label">{{ t("inspector.autoLayout") }}</span>
          <button
            v-if="supportsLayout && !node.layout"
            class="mini"
            :disabled="readonly"
            @click="addLayout"
          >{{ t("inspector.add") }}</button>
          <button
            v-else-if="supportsLayout && node.layout"
            class="mini"
            :disabled="readonly"
            @click="removeLayout"
          >{{ t("inspector.remove") }}</button>
        </div>

        <template v-if="node.layout">
          <div class="seg">
            <button :class="{ on: node.layout.direction === 'horizontal' }" :disabled="readonly" @click="setLayout({ direction: 'horizontal' })">{{ t("inspector.horizontal") }}</button>
            <button :class="{ on: node.layout.direction === 'vertical' }" :disabled="readonly" @click="setLayout({ direction: 'vertical' })">{{ t("inspector.vertical") }}</button>
          </div>
          <div class="grid two">
            <label>{{ t("inspector.gap") }}</label>
            <div class="field-with-token">
              <input class="mono" type="number" :value="fmt(layoutView?.gap ?? 0)" :disabled="readonly" @change="setLayout({ gap: num($event) })" />
              <TokenLink :token="layoutTokenOf('gap')" :disabled="readonly" @open="openLayoutToken('gap', $event)" />
            </div>
            <label>{{ t("inspector.padding") }}</label>
            <div class="field-with-select">
              <input class="mono" type="number" :value="numValue(paddingUnified())" :placeholder="t('inspector.mixed')" :disabled="readonly" @change="setPaddingAll" />
              <TokenLink :token="allPaddingToken()" :disabled="readonly" @open="openPaddingToken('all', $event)" />
              <button class="mini corner-toggle" :disabled="readonly" @click="paddingExpanded = !paddingExpanded">
                {{ paddingExpanded ? t("inspector.uniform") : t("inspector.sides") }}
              </button>
            </div>
          </div>
          <div v-if="paddingExpanded" class="grid two">
            <label>{{ t("inspector.top") }}</label>
            <div class="field-with-token">
              <input class="mono" type="number" :value="fmt(paddingOf(node).top)" :disabled="readonly" @change="setPaddingSide('top', $event)" />
              <TokenLink :token="paddingTokenOf('top')" :disabled="readonly" @open="openPaddingToken('top', $event)" />
            </div>
            <label>{{ t("inspector.right") }}</label>
            <div class="field-with-token">
              <input class="mono" type="number" :value="fmt(paddingOf(node).right)" :disabled="readonly" @change="setPaddingSide('right', $event)" />
              <TokenLink :token="paddingTokenOf('right')" :disabled="readonly" @open="openPaddingToken('right', $event)" />
            </div>
            <label>{{ t("inspector.bottom") }}</label>
            <div class="field-with-token">
              <input class="mono" type="number" :value="fmt(paddingOf(node).bottom)" :disabled="readonly" @change="setPaddingSide('bottom', $event)" />
              <TokenLink :token="paddingTokenOf('bottom')" :disabled="readonly" @open="openPaddingToken('bottom', $event)" />
            </div>
            <label>{{ t("inspector.left") }}</label>
            <div class="field-with-token">
              <input class="mono" type="number" :value="fmt(paddingOf(node).left)" :disabled="readonly" @change="setPaddingSide('left', $event)" />
              <TokenLink :token="paddingTokenOf('left')" :disabled="readonly" @open="openPaddingToken('left', $event)" />
            </div>
          </div>
          <div class="grid two">
            <label>{{ t("inspector.mainAxis") }}</label>
            <select :value="node.layout.mainAlign" :disabled="readonly" @change="setMainAlign">
              <option value="start">{{ t("inspector.start") }}</option>
              <option value="center">{{ t("inspector.center") }}</option>
              <option value="end">{{ t("inspector.end") }}</option>
              <option value="space-between">{{ t("inspector.spaceBetween") }}</option>
            </select>
            <label>{{ t("inspector.crossAxis") }}</label>
            <select :value="node.layout.crossAlign" :disabled="readonly" @change="setCrossAlign">
              <option value="start">{{ t("inspector.start") }}</option>
              <option value="center">{{ t("inspector.center") }}</option>
              <option value="end">{{ t("inspector.end") }}</option>
              <option value="stretch">{{ t("inspector.stretch") }}</option>
            </select>
          </div>
          <div class="row">
            <label>{{ t("inspector.wrap") }}</label>
            <input type="checkbox" class="checkbox" :checked="node.layout.wrap" :disabled="readonly" @change="setLayout({ wrap: boolOf($event) })" />
            <label v-if="node.layout.wrap" class="inline-label">{{ t("inspector.rowGap") }}</label>
            <div v-if="node.layout.wrap" class="field-with-token">
              <input class="mono" type="number" :value="fmt(layoutView?.crossGap ?? 0)" :disabled="readonly" @change="setLayout({ crossGap: num($event) })" />
              <TokenLink :token="layoutTokenOf('crossGap')" :disabled="readonly" @open="openLayoutToken('crossGap', $event)" />
            </div>
          </div>
          <div v-if="node.layout.wrap" class="grid two">
            <label>{{ t("inspector.multiline") }}</label>
            <select :value="node.layout.alignContent" :disabled="readonly" @change="setAlignContent">
              <option value="start">{{ t("inspector.start") }}</option>
              <option value="center">{{ t("inspector.center") }}</option>
              <option value="end">{{ t("inspector.end") }}</option>
              <option value="space-between">{{ t("inspector.spaceBetween") }}</option>
              <option value="stretch">{{ t("inspector.stretch") }}</option>
            </select>
          </div>
        </template>
        <div v-else class="row"><span class="muted">{{ t("inspector.autoLayoutOff") }}</span></div>
      </section>

      <!-- 文本 -->
      <section v-if="allText" class="block">
        <div class="label-row">
          <span class="micro-label">{{ t("inspector.text") }}</span>
          <select class="inline-select" :value="node.textAutoResize ?? 'auto-width'" :disabled="readonly || multi" @change="setAutoResize">
            <option value="auto-width">{{ t("inspector.autoWidth") }}</option>
            <option value="auto-height">{{ t("inspector.autoHeight") }}</option>
            <option value="fixed">{{ t("inspector.fixed") }}</option>
          </select>
        </div>
        <div v-if="multi" class="row"><span class="muted">{{ t("inspector.multiText") }}</span></div>
        <div v-if="!multi" class="row text-row">
          <label>{{ t("inspector.content") }}</label>
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
          <label>{{ t("inspector.font") }}</label>
          <div class="field-with-select">
            <select :value="node.style.fontFamily ?? FONT_STACKS[0].value" :disabled="readonly" @change="setTextStyle('fontFamily', $event)">
              <option v-for="f in FONT_STACKS" :key="f.value" :value="f.value">{{ t(f.labelKey) }}</option>
              <optgroup v-if="importedFamilies.length" :label="t('inspector.imported')">
                <option v-for="f in importedFamilies" :key="f" :value="`'${f}', sans-serif`">{{ f }}</option>
              </optgroup>
            </select>
            <button class="mini" :disabled="readonly" :title="t('inspector.importFontTitle')" @click="fontInput?.click()">{{ t("inspector.import") }}</button>
          </div>
          <input ref="fontInput" type="file" accept=".ttf,.otf,.woff,.woff2" class="hidden-input" @change="importFont" />
          <label>{{ t("inspector.weight") }}</label>
          <select :value="String(node.style.fontWeight ?? 400)" :disabled="readonly" @change="setTextStyle('fontWeight', $event, Number)">
            <option v-for="w in weightOptions" :key="w" :value="String(w)">{{ w }}</option>
          </select>
          <label>{{ t("inspector.size") }}</label>
          <div class="field-with-token">
            <input class="mono" type="number" min="1" :value="fmt(styleView?.fontSize ?? 20)" :disabled="readonly" @change="setTextStyle('fontSize', $event, Number)" />
            <TokenLink :token="scalarTokenOf('fontSize')" :disabled="readonly" @open="openScalarToken('fontSize', $event)" />
          </div>
          <label>{{ t("inspector.lineHeight") }}</label>
          <div class="field-with-select">
            <input
              class="mono"
              type="number"
              :value="node.style.lineHeightUnit === 'auto' || !node.style.lineHeightUnit ? '' : fmt(styleView?.lineHeight ?? 0)"
              :placeholder="t('inspector.auto')"
              :disabled="readonly || !node.style.lineHeightUnit || node.style.lineHeightUnit === 'auto'"
              @change="setTextStyle('lineHeight', $event, Number)"
            />
            <TokenLink :token="scalarTokenOf('lineHeight')" :disabled="readonly" @open="openScalarToken('lineHeight', $event)" />
            <select :value="node.style.lineHeightUnit ?? 'auto'" :disabled="readonly" @change="setTextStyle('lineHeightUnit', $event)">
              <option value="auto">{{ t("inspector.auto") }}</option>
              <option value="px">px</option>
              <option value="percent">%</option>
            </select>
          </div>
          <label>{{ t("inspector.letterSpacing") }}</label>
          <div class="field-with-select">
            <input class="mono" type="number" :value="fmt(styleView?.letterSpacing ?? 0)" :disabled="readonly" @change="setTextStyle('letterSpacing', $event, Number)" />
            <TokenLink :token="scalarTokenOf('letterSpacing')" :disabled="readonly" @open="openScalarToken('letterSpacing', $event)" />
            <select :value="node.style.letterSpacingUnit ?? 'px'" :disabled="readonly" @change="setTextStyle('letterSpacingUnit', $event)">
              <option value="px">px</option>
              <option value="percent">%</option>
            </select>
          </div>
          <label>{{ t("inspector.paragraphSpacing") }}</label>
          <div class="field-with-token">
            <input class="mono" type="number" :value="fmt(styleView?.paragraphSpacing ?? 0)" :disabled="readonly" @change="setTextStyle('paragraphSpacing', $event, Number)" />
            <TokenLink :token="scalarTokenOf('paragraphSpacing')" :disabled="readonly" @open="openScalarToken('paragraphSpacing', $event)" />
          </div>
        </div>
        <div class="row">
          <label>{{ t("inspector.italic") }}</label>
          <input
            type="checkbox"
            class="checkbox"
            :checked="node.style.fontStyle === 'italic'"
            :disabled="readonly"
            @change="applyTextStyle({ fontStyle: boolOf($event) ? 'italic' : 'normal' })"
          />
          <label class="inline-label">{{ t("inspector.truncate") }}</label>
          <input
            type="checkbox"
            class="checkbox"
            :checked="Boolean(node.truncate)"
            :disabled="readonly || (node.textAutoResize ?? 'auto-width') !== 'fixed'"
            @change="setTruncate"
          />
          <label class="inline-label">{{ t("inspector.list") }}</label>
          <select class="inline-select" :value="node.listType ?? 'none'" :disabled="readonly" @change="setListType">
            <option value="none">{{ t("inspector.listNone") }}</option>
            <option value="bulleted">{{ t("inspector.listBulleted") }}</option>
            <option value="numbered">{{ t("inspector.listNumbered") }}</option>
          </select>
        </div>
        <div class="seg small">
          <button :class="{ on: (node.style.textAlign ?? 'left') === 'left' }" :disabled="readonly" @click="applyTextStyle({ textAlign: 'left' })">{{ t("inspector.alignTextLeft") }}</button>
          <button :class="{ on: node.style.textAlign === 'center' }" :disabled="readonly" @click="applyTextStyle({ textAlign: 'center' })">{{ t("inspector.alignTextCenter") }}</button>
          <button :class="{ on: node.style.textAlign === 'right' }" :disabled="readonly" @click="applyTextStyle({ textAlign: 'right' })">{{ t("inspector.alignTextRight") }}</button>
          <button :class="{ on: node.style.textAlign === 'justify' }" :disabled="readonly" @click="applyTextStyle({ textAlign: 'justify' })">{{ t("inspector.alignTextJustify") }}</button>
        </div>
        <div class="seg small">
          <button :class="{ on: (node.style.textVerticalAlign ?? 'top') === 'top' }" :disabled="readonly" @click="applyTextStyle({ textVerticalAlign: 'top' })">{{ t("inspector.verticalTop") }}</button>
          <button :class="{ on: node.style.textVerticalAlign === 'middle' }" :disabled="readonly" @click="applyTextStyle({ textVerticalAlign: 'middle' })">{{ t("inspector.verticalMiddle") }}</button>
          <button :class="{ on: node.style.textVerticalAlign === 'bottom' }" :disabled="readonly" @click="applyTextStyle({ textVerticalAlign: 'bottom' })">{{ t("inspector.verticalBottom") }}</button>
        </div>
        <div class="grid two">
          <label>{{ t("inspector.case") }}</label>
          <select :value="node.style.textCase ?? 'none'" :disabled="readonly" @change="setTextStyle('textCase', $event)">
            <option value="none">{{ t("inspector.caseNone") }}</option>
            <option value="upper">{{ t("inspector.caseUpper") }}</option>
            <option value="lower">{{ t("inspector.caseLower") }}</option>
            <option value="title">{{ t("inspector.caseTitle") }}</option>
          </select>
          <label>{{ t("inspector.decoration") }}</label>
          <select :value="node.style.textDecoration ?? 'none'" :disabled="readonly" @change="setTextStyle('textDecoration', $event)">
            <option value="none">{{ t("inspector.decorationNone") }}</option>
            <option value="underline">{{ t("inspector.decorationUnderline") }}</option>
            <option value="strikethrough">{{ t("inspector.decorationStrikethrough") }}</option>
          </select>
        </div>
      </section>

      <!-- 外观 -->
      <section v-if="supportsFill || supportsStroke" class="block">
        <span class="micro-label">{{ t("inspector.appearance") }}</span>
        <div v-if="supportsFill" class="row">
          <label>{{ node.type === "page" ? t("inspector.background") : t("inspector.fill") }}</label>
          <div class="color-control">
            <span class="swatch" :style="{ background: colorOf(node.style.fill) }" />
            <select :value="fillTokenOf(node)" :disabled="readonly" @change="setFill">
              <option value="">{{ t("inspector.none") }}</option>
              <option value="__custom">{{ t("inspector.custom") }}</option>
              <option v-for="t in tokenNames" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
        </div>
        <div v-if="supportsFill && node.style.fill && !node.style.fill.token" class="row sub-row">
          <label />
          <input type="color" class="color-input" :value="colorOf(node.style.fill)" :disabled="readonly" @input="setCustomPaint('fill', $event)" />
          <input class="mono hex" :value="node.style.fill.value ?? ''" :disabled="readonly" @change="setCustomPaint('fill', $event)" />
        </div>
        <!-- 页面背景图：盖在背景色之上 -->
        <template v-if="node.type === 'page'">
          <div class="row">
            <label>{{ t("inspector.backgroundImage") }}</label>
            <div class="color-control">
              <button class="mini" :disabled="readonly" @click="backgroundInput?.click()">
                {{ node.backgroundImage ? t("inspector.change") : t("inspector.choose") }}
              </button>
              <select
                v-if="node.backgroundImage"
                :value="node.backgroundImage.fit"
                :disabled="readonly"
                @change="setBackgroundFit"
              >
                <option value="cover">{{ t("inspector.cover") }}</option>
                <option value="contain">{{ t("inspector.contain") }}</option>
                <option value="tile">{{ t("inspector.tile") }}</option>
              </select>
              <button v-if="node.backgroundImage" class="mini" :disabled="readonly" @click="clearBackgroundImage">
                {{ t("inspector.clear") }}
              </button>
            </div>
          </div>
          <input ref="backgroundInput" type="file" accept="image/*" class="hidden-input" @change="setBackgroundImage" />
        </template>

        <div v-if="supportsStroke" class="row">
          <label>{{ t("inspector.stroke") }}</label>
          <div class="color-control">
            <span class="swatch" :style="{ background: colorOf(node.style.stroke) }" />
            <select :value="strokeTokenOf(node)" :disabled="readonly" @change="setStroke">
              <option value="">{{ t("inspector.none") }}</option>
              <option value="__custom">{{ t("inspector.custom") }}</option>
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
          <label>{{ t("inspector.strokeWidth") }}</label>
          <div class="field-with-token">
            <input class="mono" type="number" min="0" step="0.5" :value="styleView?.strokeWidth ?? 1" :disabled="readonly" @change="setStrokeWidth($event)" />
            <TokenLink :token="scalarTokenOf('strokeWidth')" :disabled="readonly" @open="openScalarToken('strokeWidth', $event)" />
          </div>
        </div>
        <div v-if="supportsRadius" class="row">
          <label>{{ t("inspector.radius") }}</label>
          <div class="field-with-select">
            <input class="mono" type="number" min="0" :value="numValue(radiusUnified())" :placeholder="t('inspector.mixed')" :disabled="readonly" @change="setRadiusAll" />
            <TokenLink :token="allCornerToken()" :disabled="readonly" @open="openCornerToken('all', $event)" />
            <button class="mini corner-toggle" :disabled="readonly" @click="radiusExpanded = !radiusExpanded">
              {{ radiusExpanded ? t("inspector.radiusUniform") : t("inspector.radiusCorners") }}
            </button>
          </div>
        </div>
        <div v-if="supportsRadius && radiusExpanded" class="grid two">
          <label>{{ t("inspector.topLeft") }}</label>
          <div class="field-with-token">
            <input class="mono" type="number" min="0" :value="fmt(radiusOf(node).topLeft)" :disabled="readonly" @change="setRadiusCorner('topLeft', $event)" />
            <TokenLink :token="cornerTokenOf('topLeft')" :disabled="readonly" @open="openCornerToken('topLeft', $event)" />
          </div>
          <label>{{ t("inspector.topRight") }}</label>
          <div class="field-with-token">
            <input class="mono" type="number" min="0" :value="fmt(radiusOf(node).topRight)" :disabled="readonly" @change="setRadiusCorner('topRight', $event)" />
            <TokenLink :token="cornerTokenOf('topRight')" :disabled="readonly" @open="openCornerToken('topRight', $event)" />
          </div>
          <label>{{ t("inspector.bottomRight") }}</label>
          <div class="field-with-token">
            <input class="mono" type="number" min="0" :value="fmt(radiusOf(node).bottomRight)" :disabled="readonly" @change="setRadiusCorner('bottomRight', $event)" />
            <TokenLink :token="cornerTokenOf('bottomRight')" :disabled="readonly" @open="openCornerToken('bottomRight', $event)" />
          </div>
          <label>{{ t("inspector.bottomLeft") }}</label>
          <div class="field-with-token">
            <input class="mono" type="number" min="0" :value="fmt(radiusOf(node).bottomLeft)" :disabled="readonly" @change="setRadiusCorner('bottomLeft', $event)" />
            <TokenLink :token="cornerTokenOf('bottomLeft')" :disabled="readonly" @open="openCornerToken('bottomLeft', $event)" />
          </div>
        </div>
        <div v-if="supportsClip" class="row">
          <label>{{ t("inspector.clip") }}</label>
          <input type="checkbox" class="checkbox" :checked="node.clip" :disabled="readonly" @change="toggleClip" />
        </div>
        <div v-if="!multi && node.type === 'path'" class="row">
          <label>{{ t("inspector.closed") }}</label>
          <input type="checkbox" class="checkbox" :checked="Boolean(node.vector?.closed)" :disabled="readonly || !canClosePath(node)" @change="setClosed" />
        </div>
        <div v-if="!multi && node.type === 'polygon'" class="row">
          <label>{{ t("inspector.sidesCount") }}</label>
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

      <!-- 效果：投影 / 内阴影 / 图层模糊 / 背景模糊（有序，整体替换） -->
      <section v-if="supportsEffects" class="block">
        <span class="micro-label">{{ t("inspector.effects") }}</span>
        <div v-for="(effect, index) in effectsOf(node)" :key="index" class="effect-item">
          <div class="row">
            <label>{{ effectLabel(effect.type) }}</label>
            <div class="effect-actions">
              <button class="mini" :disabled="readonly" @click="toggleEffect(index)">
                {{ effect.visible ? t("inspector.hide") : t("inspector.show") }}
              </button>
              <button class="mini" :disabled="readonly" @click="removeEffect(index)">{{ t("inspector.delete") }}</button>
            </div>
          </div>
          <template v-if="isShadowEffectOf(effect)">
            <div class="grid two">
              <label>X</label>
              <input class="mono" type="number" step="1" :value="fmt(effect.x)" :disabled="readonly" @change="setEffectNumber(index, 'x', $event)" />
              <label>Y</label>
              <input class="mono" type="number" step="1" :value="fmt(effect.y)" :disabled="readonly" @change="setEffectNumber(index, 'y', $event)" />
              <label>{{ t("inspector.blur") }}</label>
              <input class="mono" type="number" min="0" step="1" :value="fmt(effect.blur)" :disabled="readonly" @change="setEffectNumber(index, 'blur', $event)" />
              <label>{{ t("inspector.spread") }}</label>
              <input class="mono" type="number" step="1" :value="fmt(effect.spread)" :disabled="readonly" @change="setEffectNumber(index, 'spread', $event)" />
            </div>
            <div class="row sub-row">
              <label>{{ t("inspector.color") }}</label>
              <div class="color-control">
                <span class="swatch" :style="{ background: shadowColorOf(effect) }" />
                <select :value="effect.color.token ?? (effect.color.value ? '__custom' : '')" :disabled="readonly" @change="setEffectColorToken(index, $event)">
                  <option value="">{{ t("inspector.default") }}</option>
                  <option value="__custom">{{ t("inspector.custom") }}</option>
                  <option v-for="t in tokenNames" :key="t" :value="t">{{ t }}</option>
                </select>
              </div>
            </div>
            <div v-if="!effect.color.token" class="row sub-row">
              <label />
              <input type="color" class="color-input" :value="shadowColorOf(effect)" :disabled="readonly" @input="setEffectColorValue(index, $event)" />
              <input class="mono hex" :value="effect.color.value ?? ''" :disabled="readonly" @change="setEffectColorValue(index, $event)" />
            </div>
          </template>
          <div v-else class="row">
            <label>{{ t("inspector.radiusValue") }}</label>
            <input class="mono" type="number" min="0" step="1" :value="fmt(effect.radius)" :disabled="readonly" @change="setEffectNumber(index, 'radius', $event)" />
          </div>
        </div>
        <div class="row">
          <label />
          <select class="effect-add" :value="''" :disabled="readonly" @change="addEffect(($event.target as HTMLSelectElement).value)">
            <option value="">{{ t("inspector.addEffect") }}</option>
            <option v-for="t in EFFECT_TYPES" :key="t" :value="t">{{ effectLabel(t) }}</option>
          </select>
        </div>
      </section>

      <section class="block" v-if="node.type === 'slot' || canMakeSlot">
        <span class="micro-label">{{ t("inspector.slot") }}</span>
        <div v-if="canMakeSlot" class="row">
          <button class="mini wide" @click="toSlot">{{ t("inspector.toSlot") }}</button>
        </div>
        <template v-else>
          <div class="row">
            <span class="muted">
              {{ instanceOwner ? (node.slotFilled ? t("inspector.slotFilled") : t("inspector.slotDefaultShown")) : t("inspector.slotDefault") }}
            </span>
          </div>
          <div class="row" v-if="instanceOwner">
            <button class="mini wide" :disabled="!node.slotFilled" @click="clearSlot">{{ t("inspector.clearSlot") }}</button>
          </div>
          <div v-else class="row"><span class="muted">{{ t("inspector.slotHint") }}</span></div>
        </template>
      </section>

      <section class="block" v-if="node.type === 'component' || componentContext || instanceProps">
        <span class="micro-label">{{ t("inspector.componentProps") }}</span>

        <template v-if="node.type === 'component'">
          <div v-if="!componentDefs.length" class="row"><span class="muted">{{ t("inspector.noProps") }}</span></div>
          <div v-for="def in componentDefs" :key="def.id" class="prop-def">
            <input class="prop-name" :value="def.name" @change="renameDef(def, $event)" />
            <span class="muted">{{ propTypeLabel(def.type) }}</span>
            <span class="muted prop-target">{{ def.targetMainId === node.id ? t("inspector.wholeComponent") : (docStore.doc.nodes[def.targetMainId]?.name ?? "—") }}</span>
            <button class="mini" @click="deleteDef(def)">{{ t("inspector.delete") }}</button>
          </div>
          <div class="row"><button class="mini wide" @click="defineProp('boolean')">{{ t("inspector.createBooleanWhole") }}</button></div>
        </template>

        <template v-else-if="componentContext">
          <div v-if="targetProp" class="row">
            <span class="muted">{{ t("inspector.alreadyProp", { name: targetProp.name, type: propTypeLabel(targetProp.type) }) }}</span>
          </div>
          <template v-else>
            <div class="row" v-if="node.type === 'text'">
              <button class="mini wide" @click="defineProp('text')">{{ t("inspector.createTextProp") }}</button>
            </div>
            <div class="row"><button class="mini wide" @click="defineProp('boolean')">{{ t("inspector.createBooleanProp") }}</button></div>
            <div class="row" v-if="node.type === 'instance'">
              <button class="mini wide" @click="defineProp('instance')">{{ t("inspector.createInstanceProp") }}</button>
            </div>
          </template>
        </template>

        <template v-else-if="instanceProps">
          <div class="row">
            <label>{{ t("inspector.component") }}</label>
            <select :value="instanceProps.instance.componentId ?? ''" @change="onSwapComponent">
              <option v-for="c in allComponents" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>
          <div class="row">
            <button class="mini" @click="gotoMaster">{{ t("inspector.gotoMaster") }}</button>
            <button class="mini" @click="detachInstance">{{ t("inspector.detach") }}</button>
          </div>
          <div v-if="!instanceProps.defs.length" class="row"><span class="muted">{{ t("inspector.noComponentProps") }}</span></div>
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
            <button v-if="hasPropValue(def)" class="mini" @click="setProp(def, null)">{{ t("inspector.reset") }}</button>
          </div>
        </template>
      </section>

      <section class="block" v-if="outerOverrideView">
        <span class="micro-label">{{ t("inspector.outerOverrides") }}</span>
        <div v-for="f in outerOverrideView.fields" :key="f" class="row ovr-row">
          <label>{{ fieldLabel(f) }}</label>
          <button class="mini" @click="resetOuterField(f)">{{ t("inspector.reset") }}</button>
        </div>
      </section>

      <section class="block" v-if="instanceOwner">
        <span class="micro-label">{{ t("inspector.instanceOverrides") }}</span>
        <div class="row">
          <span class="muted">{{ instanceOwner.isRoot ? t("inspector.instanceRoot") : t("inspector.insideInstance") }}</span>
        </div>
        <div v-if="overrideView">
          <div v-for="f in overrideView.fields" :key="f" class="row ovr-row">
            <label>{{ fieldLabel(f) }}</label>
            <button class="mini" @click="resetField(f)">{{ t("inspector.reset") }}</button>
          </div>
        </div>
        <div v-else class="row">
          <span class="muted">{{ t("inspector.noOverrides") }}</span>
        </div>
        <div class="row" v-if="instanceOwner.count">
          <button class="mini wide" @click="resetAllOverrides">{{ t("inspector.resetAll", { count: instanceOwner.count }) }}</button>
        </div>
      </section>
    </template>

    <div v-else class="empty">
      <p>{{ t("inspector.noSelection") }}</p>
      <span>{{ t("inspector.selectHint") }}</span>
    </div>
      </template>

      <template v-else>
        <div v-if="!node" class="empty">
          <p>{{ t("inspector.linkHintEmpty") }}</p>
        </div>

        <template v-else>
          <section v-if="node.type === 'page'" class="block">
            <span class="micro-label">{{ t("inspector.scroll") }}</span>
            <div class="row">
              <select :value="node.scrollDirection ?? 'none'" :disabled="multi" @change="setScrollDirection">
                <option value="none">{{ t("inspector.scrollNone") }}</option>
                <option value="vertical">{{ t("inspector.scrollVertical") }}</option>
                <option value="horizontal">{{ t("inspector.scrollHorizontal") }}</option>
              </select>
            </div>
            <div class="row">
              <span class="muted">{{ multi ? t("inspector.scrollHintMulti") : t("inspector.scrollHint") }}</span>
            </div>
          </section>

          <section v-else class="block">
            <span class="micro-label">{{ t("inspector.link") }}</span>

            <div v-if="linkBlocked" class="row">
              <span class="muted">{{ linkBlocked }}</span>
            </div>

            <template v-else>
              <div class="row">
                <label>{{ t("inspector.linkTarget") }}</label>
                <select :value="linkTargetValue" @change="setLinkTarget">
                  <option value="">{{ t("inspector.linkNone") }}</option>
                  <option value="__back__">{{ t("inspector.linkBack") }}</option>
                  <option v-for="page in linkPages" :key="page.id" :value="page.id">{{ page.name }}</option>
                </select>
              </div>

              <template v-if="link && link.action === 'navigate'">
                <div class="row">
                  <label>{{ t("inspector.linkTransition") }}</label>
                  <select :value="link.transition.type" @change="setLinkTransition">
                    <option value="instant">{{ t("inspector.transitionInstant") }}</option>
                    <option value="dissolve">{{ t("inspector.transitionDissolve") }}</option>
                  </select>
                </div>
                <div v-if="link.transition.type === 'dissolve'" class="row">
                  <label>{{ t("inspector.linkDuration") }}</label>
                  <input
                    class="mono"
                    type="number"
                    min="60"
                    max="2000"
                    step="10"
                    :value="link.transition.durationMs"
                    @change="setLinkDuration"
                  />
                </div>
              </template>

              <div v-if="link" class="row">
                <button class="mini" @click="removeLink">{{ t("inspector.removeLink") }}</button>
              </div>
              <div v-if="extraLinkCount" class="row">
                <span class="muted">{{ t("inspector.extraLinks", { count: extraLinkCount }) }}</span>
              </div>
            </template>
          </section>
        </template>
      </template>
    </template>
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
  background: var(--tint-4);
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
  background: var(--tint-5);
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

.align-row {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.align-row .icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  padding: 0;
}

.align-row .icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.hidden-input {
  display: none;
}

.hint {
  margin: 6px 0 0;
  font-size: 10.5px;
  color: var(--text-faint);
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

.field-with-token {
  display: flex;
  gap: 4px;
  min-width: 0;
}

.field-with-token > input {
  flex: 1;
}

.row > .field-with-token {
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
  background: var(--tint-4);
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
  background: var(--tint-5);
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
  background: var(--tint-4);
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
  background: var(--tint-5);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.seg {
  display: flex;
  gap: 2px;
  background: var(--tint-35);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
  padding: 2px;
}

.seg.small button {
  padding: 3px 6px;
  font-size: 11px;
}

.tabs {
  margin: 0 2px 8px;
}

.tabs button {
  padding: 5px 6px;
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
