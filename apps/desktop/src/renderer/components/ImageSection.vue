<script setup lang="ts">
/**
 * 检查器里的图片区块：预览、替换（本地文件 / 远程链接）、裁切、蒙版。
 * 本地图片的字节在资源仓库（assets.ts），链接图只在文档里存 URL，
 * 字节按需抓取并缓存在本机（linked-images.ts）。
 */
import { computed, ref, watch } from "vue";
import { imageCropOf, type DocNode } from "@sqraft/core";
import { assetUrl, putAsset } from "../assets";
import { dispatch, ui } from "../store";
import { linkedImageStatus, linkedNaturalSize, linkedPreviewUrl, linkedVersion, refreshLinkedImage, ensureLinkedImage } from "../linked-images";
import { naturalSizeOf } from "../canvas/crop-drag";
import { t } from "../i18n";

const props = defineProps<{ node: DocNode }>();

const fileInput = ref<HTMLInputElement | null>(null);
const message = ref("");
const urlDraft = ref(props.node.image?.sourceUrl ?? "");

watch(
  () => props.node.id,
  () => {
    urlDraft.value = props.node.image?.sourceUrl ?? "";
    message.value = "";
  },
);

// 撤销/重做或 agent 换了链接：输入框跟着文档走
watch(
  () => props.node.image?.sourceUrl ?? "",
  (url) => {
    urlDraft.value = url;
  },
);

const sourceUrl = computed(() => props.node.image?.sourceUrl ?? null);
const preview = computed(() => {
  void linkedVersion.value;
  const image = props.node.image;
  if (!image) return null;
  if (image.assetId) return assetUrl(image.assetId);
  return linkedPreviewUrl(image.sourceUrl);
});
const natural = computed(() => {
  void linkedVersion.value;
  // 链接图抓取前文档里是 0；解码完成后从缓存里拿真实尺寸
  return naturalSizeOf(props.node);
});
const crop = computed(() => imageCropOf(props.node, natural.value));
const cropping = computed(() => ui.cropNodeId === props.node.id);
const linkState = computed(() => {
  void linkedVersion.value;
  return sourceUrl.value ? linkedImageStatus(sourceUrl.value) : null;
});

// 加载是副作用，放在 watch 里：computed 只读状态，不在渲染期发请求
watch(
  sourceUrl,
  (url) => {
    if (url) void ensureLinkedImage(url);
  },
  { immediate: true },
);
const canCrop = computed(() => natural.value.width > 0 && natural.value.height > 0);

function applyImage(next: { assetId: string; width: number; height: number }, keepBox: boolean): void {
  dispatch(
    {
      type: "node.update",
      params: {
        nodeId: props.node.id,
        patch: {
          ...(keepBox ? {} : { width: next.width, height: next.height }),
          image: {
            assetId: next.assetId,
            naturalWidth: next.width,
            naturalHeight: next.height,
            // 换图不继承上一张的裁切
            crop: { x: 0, y: 0, width: next.width, height: next.height },
          },
        },
      },
    },
    "replace-image",
  );
}

async function onPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  message.value = "";
  const asset = await putAsset(new Uint8Array(await file.arrayBuffer()));
  if (!asset.ok) {
    message.value = asset.reason;
    return;
  }
  applyImage(asset, true);
}

/** 换成远程链接：尺寸未知（0），抓取由渲染层按需触发；裁切重置为整图。 */
function applyUrl(): void {
  const raw = urlDraft.value.trim();
  if (!raw) {
    message.value = t("image.pasteUrl");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    message.value = t("image.invalidUrl");
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    message.value = t("image.onlyHttp");
    return;
  }
  message.value = "";
  dispatch(
    {
      type: "node.update",
      params: {
        nodeId: props.node.id,
        patch: { image: { sourceUrl: raw, naturalWidth: 0, naturalHeight: 0 } },
      },
    },
    "link-image",
  );
}

function refetch(): void {
  if (sourceUrl.value) refreshLinkedImage(sourceUrl.value);
}

/** 链接图抓到之后按原图比例铺满节点（不改动其它节点）。 */
function fitNatural(): void {
  if (!canCrop.value) return;
  dispatch(
    {
      type: "node.update",
      params: { nodeId: props.node.id, patch: { width: natural.value.width, height: natural.value.height } },
    },
    "fit-image",
  );
}

function toggleCrop(): void {
  if (!canCrop.value) {
    message.value = t("image.notReady");
    return;
  }
  if (cropping.value) {
    ui.cropNodeId = null;
    return;
  }
  // 裁切手柄依赖"单选"，这里同步一次选区
  ui.selection = [props.node.id];
  ui.cropNodeId = props.node.id;
}

function toggleMask(): void {
  dispatch(
    { type: "node.update", params: { nodeId: props.node.id, patch: { isMask: !props.node.isMask } } },
    "toggle-mask",
  );
}
</script>

<template>
  <section class="block">
    <div class="label-row">
      <span class="micro-label">{{ t("image.title") }}</span>
      <div class="actions">
        <button class="mini" :class="{ on: cropping }" @click="toggleCrop">
          {{ cropping ? t("image.exitCrop") : t("image.crop") }}
        </button>
        <button class="mini" @click="fileInput?.click()">{{ t("image.replace") }}</button>
      </div>
    </div>

    <div class="preview">
      <img v-if="preview" :src="preview" alt="" />
      <span v-else class="missing">
        {{ linkState ? (linkState.status === "failed" ? t("image.failed") : t("image.loading")) : t("image.missing") }}
      </span>
    </div>

    <div class="facts">
      <span>{{ t("image.natural", { width: natural.width, height: natural.height }) }}</span>
      <span>{{ t("image.cropSize", { width: Math.round(crop.width), height: Math.round(crop.height) }) }}</span>
    </div>

    <div class="url-row">
      <input
        v-model="urlDraft"
        class="url-input"
        type="text"
        :placeholder="t('image.urlPlaceholder')"
        @keydown.enter.prevent="applyUrl"
      />
      <button class="mini" @click="applyUrl">{{ sourceUrl ? t("image.changeLink") : t("image.useLink") }}</button>
    </div>

    <div v-if="sourceUrl" class="link-row">
      <span class="link-text" :title="sourceUrl">{{ sourceUrl }}</span>
      <button class="mini" @click="refetch">{{ t("image.refetch") }}</button>
      <button class="mini" :disabled="!canCrop" @click="fitNatural">{{ t("image.fitNatural") }}</button>
    </div>

    <p v-if="linkState?.status === 'failed'" class="message">{{ linkState.error }}</p>

    <label class="mask-row">
      <input type="checkbox" :checked="node.isMask" @change="toggleMask" />
      <span>{{ t("image.mask") }}</span>
    </label>

    <p v-if="message" class="message">{{ message }}</p>

    <input
      ref="fileInput"
      class="hidden-input"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
      @change="onPicked"
    />
  </section>
</template>

<style scoped>
.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.actions {
  display: flex;
  gap: 4px;
}

.mini {
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  padding: 2px 8px;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.mini:hover {
  color: var(--text);
  border-color: var(--hairline-strong);
}

.mini.on {
  color: var(--text);
  background: var(--tint-5);
}

.preview {
  height: 96px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline);
  background: var(--tint-4);
  display: grid;
  place-items: center;
  overflow: hidden;
}

.preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.missing {
  font-size: 11px;
  color: var(--text-faint);
}

.facts {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-faint);
  font-family: var(--mono);
}

.url-row {
  display: flex;
  gap: 4px;
}

.url-input {
  min-width: 0;
  flex: 1;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 11px;
}

.url-input:focus {
  outline: none;
  border-color: var(--hairline-strong);
}

.link-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.link-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--text-faint);
  font-family: var(--mono);
}

.mini:disabled {
  opacity: 0.45;
  cursor: default;
}

.mask-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
  cursor: pointer;
}

.message {
  margin: 0;
  font-size: 11px;
  color: #b91c1c;
}

.hidden-input {
  display: none;
}
</style>
