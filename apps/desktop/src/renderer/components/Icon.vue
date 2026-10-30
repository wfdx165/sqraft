<script setup lang="ts">
/** 超细线性图标集（1.25px 描边，自绘，不依赖图标库）；路径定义在 icons.ts，画布叠加层共用。 */
import { ICON_PATHS, ICON_STROKE } from "../icons";

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 });
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="ICON_STROKE"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="ICON_PATHS[props.name] ?? ICON_PATHS.rect" />
  </svg>
</template>
