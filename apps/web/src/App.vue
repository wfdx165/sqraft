<script setup lang="ts">
import Toolbar from "./components/Toolbar.vue";
import LayersPanel from "./components/LayersPanel.vue";
import InspectorPanel from "./components/InspectorPanel.vue";
import CanvasView from "./components/CanvasView.vue";
import ChatPanel from "./components/ChatPanel.vue";
</script>

<template>
  <div class="app">
    <Toolbar />
    <div class="body">
      <aside class="left"><LayersPanel /></aside>
      <main class="center"><CanvasView /></main>
      <aside class="right"><InspectorPanel /></aside>
    </div>
    <ChatPanel />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #f5f5f7;
  color: #1a1a1a;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.left { width: 220px; overflow: auto; border-right: 1px solid #e2e2e6; background: #fff; }
.right { width: 260px; overflow: auto; border-left: 1px solid #e2e2e6; background: #fff; }
.center { flex: 1; min-width: 0; position: relative; }
</style>
