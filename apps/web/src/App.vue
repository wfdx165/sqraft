<script setup lang="ts">
import Toolbar from "./components/Toolbar.vue";
import LayersPanel from "./components/LayersPanel.vue";
import InspectorPanel from "./components/InspectorPanel.vue";
import CanvasView from "./components/CanvasView.vue";
import ChatPanel from "./components/ChatPanel.vue";
</script>

<template>
  <div class="app">
    <CanvasView />
    <Toolbar class="float toolbar rise-in" />
    <aside class="float left glass rise-in" style="animation-delay: 40ms"><LayersPanel /></aside>
    <aside class="float right glass rise-in" style="animation-delay: 80ms"><InspectorPanel /></aside>
    <ChatPanel class="float chat rise-in" style="animation-delay: 140ms" />
  </div>
</template>

<style scoped>
.app {
  position: relative;
  height: 100%;
  overflow: hidden;
  background:
    radial-gradient(900px 480px at 18% -10%, var(--bg-glow), transparent 60%),
    radial-gradient(700px 420px at 92% 108%, rgba(99, 102, 241, 0.05), transparent 60%),
    var(--bg);
}

.float {
  position: absolute;
  z-index: 10;
}

.toolbar {
  top: 14px;
  left: 50%;
  translate: -50% 0;
}

.left {
  top: 14px;
  bottom: 14px;
  left: 14px;
  width: 232px;
  overflow: auto;
}

.right {
  top: 14px;
  bottom: 14px;
  right: 14px;
  width: 276px;
  overflow: auto;
}

.chat {
  left: 50%;
  bottom: 14px;
  translate: -50% 0;
  z-index: 20;
}
</style>
