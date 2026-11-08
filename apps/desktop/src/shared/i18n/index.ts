/**
 * 界面文案的共享字典（主进程与渲染层共用）。
 *
 * 中文表是键的唯一真源；其余语言在类型上必须覆盖全部键，漏一个就编译失败。
 * 只放"用户看得到的文案"：日志、MCP 工具描述、代码注释不进来。
 */
import { zhCN } from "./zh-CN";
import { enUS } from "./en-US";
import { jaJP } from "./ja-JP";
import { koKR } from "./ko-KR";

export const LOCALES = ["zh-CN", "en-US", "ja-JP", "ko-KR"] as const;
export type Locale = (typeof LOCALES)[number];

/** 用户在设置里选的值；`auto` 表示跟随系统。 */
export type LanguagePreference = "auto" | Locale;

export const DEFAULT_LOCALE: Locale = "en-US";

export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = ["auto", ...LOCALES];

export type MessageKey = keyof typeof zhCN;
export type MessageParams = Record<string, string | number>;

const catalogs: Record<Locale, Record<MessageKey, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
  "ja-JP": jaJP,
  "ko-KR": koKR,
};

/** 系统语言 → 支持的界面语言：`zh*` / `ja*` / `ko*` 分别匹配，其余回退英文。 */
export function resolveLocale(preference: LanguagePreference, systemLocale: string): Locale {
  if (preference !== "auto") return preference;
  const system = systemLocale.toLowerCase();
  if (system.startsWith("zh")) return "zh-CN";
  if (system.startsWith("ja")) return "ja-JP";
  if (system.startsWith("ko")) return "ko-KR";
  return "en-US";
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return (
    value === "auto" ||
    (typeof value === "string" && (LOCALES as readonly string[]).includes(value))
  );
}

/** 取文案；缺键时回退英文，再回退键名（调用方会看到明显的 key）。 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const text = catalogs[locale]?.[key] ?? enUS[key] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** 当前语言的自称（设置面板里展示用，不翻译）。 */
export function localeLabel(locale: Locale): string {
  switch (locale) {
    case "zh-CN":
      return "中文";
    case "ja-JP":
      return "日本語";
    case "ko-KR":
      return "한국어";
    default:
      return "English";
  }
}
