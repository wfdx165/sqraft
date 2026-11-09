import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "./zh-CN";
import { enUS } from "./en-US";
import { jaJP } from "./ja-JP";
import { koKR } from "./ko-KR";
import { LANGUAGE_PREFERENCES, LOCALES, isLanguagePreference, resolveLocale, translate } from "./index";

const rendererDir = fileURLToPath(new URL("../../renderer", import.meta.url));

function vueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...vueFiles(path));
    else if (entry.name.endsWith(".vue")) out.push(path);
  }
  return out;
}

describe("i18n 字典", () => {
  it("四种语言的键集合一致且没有空值", () => {
    const zhKeys = Object.keys(zhCN).sort();
    const catalogs = { "en-US": enUS, "ja-JP": jaJP, "ko-KR": koKR };
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).sort(), locale).toEqual(zhKeys);
      for (const [key, value] of Object.entries(catalog)) {
        expect(value, `${locale} ${key}`).not.toBe("");
      }
    }
    for (const [key, value] of Object.entries(zhCN)) {
      expect(value, `zh-CN ${key}`).not.toBe("");
    }
  });

  it("四种语言的占位符集合一致", () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");
    for (const key of Object.keys(zhCN) as Array<keyof typeof zhCN>) {
      const expected = placeholders(zhCN[key]);
      for (const [locale, catalog] of Object.entries({ "en-US": enUS, "ja-JP": jaJP, "ko-KR": koKR })) {
        expect(placeholders(catalog[key]), `${locale} ${key}`).toBe(expected);
      }
    }
  });

  it("语言列表包含自动 + 四种语言", () => {
    expect(LOCALES).toEqual(["zh-CN", "en-US", "ja-JP", "ko-KR"]);
    expect(LANGUAGE_PREFERENCES).toEqual(["auto", "zh-CN", "en-US", "ja-JP", "ko-KR"]);
    for (const preference of LANGUAGE_PREFERENCES) {
      expect(isLanguagePreference(preference)).toBe(true);
    }
    expect(isLanguagePreference("fr-FR")).toBe(false);
    expect(isLanguagePreference(null)).toBe(false);
  });

  it("模板里不再有写死的中文文案", () => {
    const offenders: string[] = [];
    for (const file of vueFiles(rendererDir)) {
      const source = readFileSync(file, "utf8");
      const match = source.match(/<template>([\s\S]*?)<\/template>/);
      if (!match) continue;
      const template = match[1].replace(/<!--[\s\S]*?-->/g, "");
      template.split("\n").forEach((line, index) => {
        if (/[\u4e00-\u9fff]/.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("语言解析与插值", () => {
  it("auto 按系统语言匹配 zh / ja / ko，其余回退英文", () => {
    expect(resolveLocale("auto", "zh-CN")).toBe("zh-CN");
    expect(resolveLocale("auto", "zh-Hans-CN")).toBe("zh-CN");
    expect(resolveLocale("auto", "en-US")).toBe("en-US");
    expect(resolveLocale("auto", "ja-JP")).toBe("ja-JP");
    expect(resolveLocale("auto", "ja")).toBe("ja-JP");
    expect(resolveLocale("auto", "ko-KR")).toBe("ko-KR");
    expect(resolveLocale("auto", "ko")).toBe("ko-KR");
    expect(resolveLocale("auto", "fr-FR")).toBe("en-US");
    expect(resolveLocale("en-US", "zh-CN")).toBe("en-US");
    expect(resolveLocale("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveLocale("ja-JP", "en-US")).toBe("ja-JP");
    expect(resolveLocale("ko-KR", "ja-JP")).toBe("ko-KR");
  });

  it("插值替换命名参数", () => {
    expect(translate("en-US", "welcome.capability", { count: 3 })).toContain("3");
    expect(translate("zh-CN", "pages.newPageName", { n: 2 })).toBe("页面 2");
    expect(translate("ja-JP", "pages.newPageName", { n: 2 })).toBe("ページ 2");
    expect(translate("ko-KR", "pages.newPageName", { n: 2 })).toBe("페이지 2");
  });
});
