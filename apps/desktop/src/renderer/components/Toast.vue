<script setup lang="ts">
/** 底部居中的轻量提示：单一实例、不接管指针（见 toast.ts）。 */
import { toastUi } from "../toast";
</script>

<template>
  <Transition name="toast">
    <div
      v-if="toastUi.visible"
      class="toast glass"
      :class="toastUi.tone"
      role="status"
      aria-live="polite"
    >
      {{ toastUi.message }}
    </div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  translate: -50% 0;
  z-index: 55;
  max-width: min(520px, calc(100vw - 48px));
  padding: 8px 16px;
  border-radius: var(--radius-pill);
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  pointer-events: none;
  user-select: none;
}

.toast.error {
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  color: var(--danger);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
