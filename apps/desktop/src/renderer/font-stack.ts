/**
 * 按界面语言选择的 CJK 字体栈。
 *
 * 日文汉字与中文汉字共用码位，但字形不同：字体栈必须让当前语言的系统字体先命中，
 * 否则日文界面里的「直」「骨」会显示成中文字形。英文界面沿用中文回退即可。
 * 旧文档里的 fontFamily 原样保留；只有新建文本与界面自绘层使用这里的结果。
 */
import type { Locale } from "../shared/i18n";
import { locale } from "./i18n";

const CJK_SANS: Record<Locale, string> = {
  "zh-CN": "'PingFang SC', 'Microsoft YaHei'",
  "en-US": "'PingFang SC', 'Microsoft YaHei'",
  "ja-JP": "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo'",
  "ko-KR": "'Apple SD Gothic Neo', 'Malgun Gothic'",
};

const CJK_SERIF: Record<Locale, string> = {
  "zh-CN": "'Songti SC', SimSun",
  "en-US": "'Songti SC', SimSun",
  "ja-JP": "'Hiragino Mincho ProN', 'Yu Mincho'",
  "ko-KR": "'AppleMyungjo', 'Batang'",
};

/** 当前语言的 CJK 无衬线回退串（不含 Geist）。 */
export function cjkSans(target: Locale = locale.value): string {
  return CJK_SANS[target];
}

/** 当前语言的 CJK 衬线回退串。 */
export function cjkSerif(target: Locale = locale.value): string {
  return CJK_SERIF[target];
}

/** 界面与画布标签共用的无衬线栈（Geist 在前，CJK 字体由界面语言决定）。 */
export function uiFontStack(target: Locale = locale.value): string {
  return `"Geist Variable", ${cjkSans(target)}, sans-serif`;
}

/** 新建文本的默认字体：与界面字体一致，保证日文/韩文命中正确字形。 */
export function defaultTextFontFamily(target: Locale = locale.value): string {
  return uiFontStack(target);
}

/** 画布 11px 标签字体（绘制与宽度测量必须用同一个字符串）。 */
export function labelFont(target: Locale = locale.value): string {
  return `11px ${uiFontStack(target)}`;
}
