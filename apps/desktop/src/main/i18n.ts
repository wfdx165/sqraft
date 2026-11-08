/**
 * 主进程的当前界面语言。
 *
 * 偏好只存 `auto | zh-CN | en-US | ja-JP | ko-KR`；实际语言在启动时解析一次（`auto` 读 app.getLocale()）。
 * 渲染层改语言时通过 IPC 调 setMainLanguage，再重建菜单。
 */
import { app } from "electron";
import {
  resolveLocale,
  translate,
  type LanguagePreference,
  type Locale,
  type MessageKey,
  type MessageParams,
} from "../shared/i18n";

let preference: LanguagePreference = "auto";
let locale: Locale = "zh-CN";

/** 测试环境里的 electron mock 可能没有 getLocale；main 真实运行时一定有。 */
function systemLocale(): string {
  return typeof app.getLocale === "function" ? app.getLocale() : "en-US";
}

export function initMainI18n(next: LanguagePreference): Locale {
  preference = next;
  locale = resolveLocale(next, systemLocale());
  return locale;
}

export function setMainLanguage(next: LanguagePreference): Locale {
  preference = next;
  locale = resolveLocale(next, systemLocale());
  return locale;
}

export function getLanguagePreference(): LanguagePreference {
  return preference;
}

export function getLocale(): Locale {
  return locale;
}

export function t(key: MessageKey, params?: MessageParams): string {
  return translate(locale, key, params);
}
