<script setup lang="ts">
/** 数值字段的 Token 绑定入口：未绑定显示灰色回形针，已绑定高亮。 */
import Icon from "./Icon.vue";

defineProps<{ token?: string; disabled?: boolean }>();
const emit = defineEmits<{ open: [event: MouseEvent] }>();
</script>

<template>
  <button
    class="token-link"
    :class="{ on: Boolean(token) }"
    :disabled="disabled"
    :title="token ? `已绑定 Token：${token}（点击换绑或解绑）` : '绑定数值 Token'"
    type="button"
    @click.stop="emit('open', $event)"
  >
    <Icon name="paperclip" :size="11" />
  </button>
</template>

<style scoped>
.token-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  flex: none;
  transition: color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.token-link:hover:not(:disabled) {
  color: var(--text);
  background: var(--tint-4);
}
.token-link.on {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.token-link:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
