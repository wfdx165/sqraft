/**
 * 导出文件名（纯函数，便于单测）：`<文档名>-<对象名>.png`。
 */
import { t } from "./i18n";

const ILLEGAL = /[\\/:*?"<>|]/g;

/** 文件名里不能出现的字符（Windows 与 macOS 的并集）换成连字符。 */
export function pngFileName(docName: string, objectName: string): string {
  const doc = docName.replace(/\.sqraft$/i, "").trim() || t("common.untitled");
  const object = objectName.replace(ILLEGAL, "-").replace(/\s+/g, " ").trim().slice(0, 80);
  return object ? `${doc}-${object}.png` : `${doc}.png`;
}
