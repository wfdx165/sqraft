import { createApp } from "vue";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/theme.css";
import App from "./App.vue";
import { installRendererErrorLog } from "./log";

installRendererErrorLog();
createApp(App).mount("#app");
