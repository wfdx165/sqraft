import { createApp } from "vue";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/theme.css";
import App from "./App.vue";
import { installRendererErrorLog } from "./log";
import { applyLanguageState, applyResolvedLocale } from "./i18n";
import { resolveLocale } from "../shared/i18n";

installRendererErrorLog();

async function boot(): Promise<void> {
  try {
    const info = await window.sqraft.app.info();
    applyLanguageState({ language: info.language, locale: info.locale });
  } catch {
    // 拿不到主进程信息时按系统语言兜底，至少不把中文塞给英文用户
    applyResolvedLocale(resolveLocale("auto", navigator.language));
  }
  window.sqraft.app.onLanguageChange((next) => applyResolvedLocale(next));
  createApp(App).mount("#app");
}

void boot();
