<script setup lang="ts">
import Toolbar from "./components/Toolbar.vue";
import PagesPanel from "./components/PagesPanel.vue";
import InspectorPanel from "./components/InspectorPanel.vue";
import CanvasView from "./components/CanvasView.vue";
import ChatPanel from "./components/ChatPanel.vue";
import { ui } from "./store";
</script>

<template>
  <div class="app">
    <CanvasView />
    <Toolbar class="float toolbar rise-in" />
    <aside class="float left glass rise-in" style="animation-delay: 40ms">
      <div class="tabs">
        <button :class="{ on: ui.tab === 'pages' }" @click="ui.tab = 'pages'">页面</button>
        <button :class="{ on: ui.tab === 'chat' }" @click="ui.tab = 'chat'">对话 <kbd>⌘K</kbd></button>
      </div>
      <div class="tab-body">
        <PagesPanel v-show="ui.tab === 'pages'" />
        <ChatPanel v-show="ui.tab === 'chat'" />
      </div>
    </aside>
    <aside class="float right glass rise-in" style="animation-delay: 80ms"><InspectorPanel /></aside>
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
  width: 300px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tabs {
  display: flex;
  gap: 2px;
  margin: 10px 10px 0;
  padding: 2px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
}

.tabs button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: var(--radius-pill);
  padding: 4px 10px;
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.tabs button:hover {
  color: var(--text);
}

.tabs button.on {
  background: var(--glass-strong);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}

.tabs kbd {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--text-faint);
  border: 1px solid var(--hairline);
  border-radius: 4px;
  padding: 0 3px;
}

.tab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.tab-body > * {
  flex: 1;
  min-height: 0;
}

.right {
  top: 14px;
  bottom: 14px;
  right: 14px;
  width: 276px;
  overflow: auto;
}
</style>
