/**
 * 渲染层的当前语言。
 *
 * `locale` 是响应式 ref：模板里的 t() 会随它重渲染。
 * 初始值由 main.ts 在挂载前从主进程的 AppInfo 拿到，避免首屏闪中文。
 */
import { ref } from "vue";
import {
  translate,
  type LanguagePreference,
  type Locale,
  type MessageKey,
  type MessageParams,
} from "../shared/i18n";

export const locale = ref<Locale>("zh-CN");
export const languagePreference = ref<LanguagePreference>("auto");

export function applyResolvedLocale(next: Locale): void {
  locale.value = next;
  document.documentElement.lang = next;
}

export function applyLanguageState(state: { language: LanguagePreference; locale: Locale }): void {
  languagePreference.value = state.language;
  applyResolvedLocale(state.locale);
}

export async function setLanguage(preference: LanguagePreference): Promise<void> {
  const state = await window.sqraft.app.setLanguage(preference);
  applyLanguageState(state);
}

export function t(key: MessageKey, params?: MessageParams): string {
  return translate(locale.value, key, params);
}
