<script setup lang="ts">
/**
 * 检查器里的图片区块：预览、替换、裁切入口、蒙版开关。
 * 只改节点属性，图片字节始终在资源仓库里（assets.ts）。
 */
import { computed, ref } from "vue";
import { imageCropOf, type DocNode } from "@sqraft/core";
import { assetUrl, putAsset } from "../assets";
import { dispatch, ui } from "../store";

const props = defineProps<{ node: DocNode }>();

const fileInput = ref<HTMLInputElement | null>(null);
const message = ref("");

const preview = computed(() => (props.node.image ? assetUrl(props.node.image.assetId) : null));
const crop = computed(() => imageCropOf(props.node));
const natural = computed(() => ({
  width: props.node.image?.naturalWidth ?? 0,
  height: props.node.image?.naturalHeight ?? 0,
}));
const cropping = computed(() => ui.cropNodeId === props.node.id);

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

function toggleCrop(): void {
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
      <span class="micro-label">图片</span>
      <div class="actions">
        <button class="mini" :class="{ on: cropping }" @click="toggleCrop">
          {{ cropping ? "退出裁切" : "裁切" }}
        </button>
        <button class="mini" @click="fileInput?.click()">替换…</button>
      </div>
    </div>

    <div class="preview">
      <img v-if="preview" :src="preview" alt="" />
      <span v-else class="missing">图片缺失</span>
    </div>

    <div class="facts">
      <span>原图 {{ natural.width }} × {{ natural.height }}</span>
      <span>裁切 {{ Math.round(crop.width) }} × {{ Math.round(crop.height) }}</span>
    </div>

    <label class="mask-row">
      <input type="checkbox" :checked="node.isMask" @change="toggleMask" />
      <span>用作蒙版（遮罩同父级上方相邻的图层）</span>
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
