/**
 * 多倍率导出包的打包（纯函数，便于单测）：
 * 条目平铺在 ZIP 根目录；PNG 本身已压缩，按 level 0 只做存储，SVG 走常规压缩。
 */
import { zipSync, type Zippable } from "fflate";

export interface ExportZipEntry {
  /** ZIP 内的条目名，不含目录前缀 */
  name: string;
  bytes: Uint8Array;
  format: "png" | "svg";
}

export function buildExportZip(entries: readonly ExportZipEntry[]): Uint8Array {
  const files: Zippable = {};
  for (const entry of entries) {
    files[entry.name] = [entry.bytes, { level: entry.format === "png" ? 0 : 6 }];
  }
  return zipSync(files);
}
