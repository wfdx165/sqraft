/**
 * 字体仓库：导入的字体文件按内容哈希存在内存里，保存时写进 `.sqraft` 的 `fonts/`。
 *
 * 元数据优先读字体文件自带的 `name` / `OS/2` 表（ttf/otf）；woff/woff2 是压缩容器，
 * 不引入解析依赖，退化为用文件名当字族名、字重 400（用户可在导入后改）。
 */
import type { DocState, NodeId } from "@sqraft/core";
import { t } from "./i18n";

export interface FontEntry {
  /** 内容哈希，同时是 zip 里的文件名 */
  assetId: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  mime: string;
}

export interface FontRecord extends FontEntry {
  bytes: Uint8Array;
  url: string;
}

export const MAX_FONT_BYTES = 5 * 1024 * 1024;
export const MAX_FONT_TOTAL = 20 * 1024 * 1024;

const records = new Map<string, FontRecord>();
/** 已经注册到 document.fonts 的 key（family|weight|style） */
const registered = new Set<string>();
/** 注册过的 FontFace：切换文档时要从 document.fonts 里删掉，否则同名旧字体会一直生效 */
const faces = new Map<string, FontFace>();

function extensionOf(mime: string): string {
  switch (mime) {
    case "font/woff2":
      return "woff2";
    case "font/woff":
      return "woff";
    case "font/otf":
      return "otf";
    default:
      return "ttf";
  }
}

/** 按 magic bytes 判格式：扩展名不可信。 */
export function sniffFontMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag === "wOF2") return "font/woff2";
  if (tag === "wOFF") return "font/woff";
  if (tag === "OTTO") return "font/otf";
  if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return "font/ttf";
  if (tag === "true") return "font/ttf";
  return null;
}

export function fontEntryName(record: Pick<FontRecord, "assetId" | "mime">): string {
  return `fonts/${record.assetId}.${extensionOf(record.mime)}`;
}

/** Uint8Array → 独立 ArrayBuffer（Blob / digest 的类型要求）。 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** 字体文件 → 字节数组的 SHA-256 前 16 位。 */
async function fontIdFor(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toBuffer(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/**
 * 读 ttf/otf 的 `name` / `OS/2` 表拿字族与字重；读不到返回 null。
 * 只处理未压缩的 sfnt，woff/woff2 走文件名兜底。
 */
export function parseFontMeta(bytes: Uint8Array): { family: string; weight: number; style: "normal" | "italic" } | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag !== "OTTO" && !(bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return null;
  try {
    const numTables = view.getUint16(4);
    let nameOffset = -1;
    let os2Offset = -1;
    for (let i = 0; i < numTables; i += 1) {
      const entry = 12 + i * 16;
      if (entry + 16 > bytes.length) return null;
      const tableTag = String.fromCharCode(bytes[entry], bytes[entry + 1], bytes[entry + 2], bytes[entry + 3]);
      const offset = view.getUint32(entry + 8);
      if (tableTag === "name") nameOffset = offset;
      if (tableTag === "OS/2") os2Offset = offset;
    }
    let family = "";
    let subfamily = "";
    if (nameOffset >= 0 && nameOffset + 6 <= bytes.length) {
      const count = view.getUint16(nameOffset + 2);
      const stringOffset = nameOffset + view.getUint16(nameOffset + 4);
      for (let i = 0; i < count; i += 1) {
        const rec = nameOffset + 6 + i * 12;
        if (rec + 12 > bytes.length) break;
        const platformId = view.getUint16(rec);
        const nameId = view.getUint16(rec + 6);
        const length = view.getUint16(rec + 8);
        const offset = stringOffset + view.getUint16(rec + 10);
        if ((nameId !== 1 && nameId !== 2) || offset + length > bytes.length) continue;
        const raw = bytes.subarray(offset, offset + length);
        // 平台 3 是 UTF-16BE，平台 1 是 MacRoman（近似按 latin1 处理）
        const text =
          platformId === 3
            ? String.fromCharCode(...Array.from({ length: raw.length / 2 }, (_, k) => (raw[k * 2] << 8) | raw[k * 2 + 1]))
            : String.fromCharCode(...raw);
        if (nameId === 1 && !family) family = text.trim();
        if (nameId === 2 && !subfamily) subfamily = text.trim();
      }
    }
    let weight = 400;
    if (os2Offset >= 0 && os2Offset + 6 <= bytes.length) {
      const value = view.getUint16(os2Offset + 4);
      if (value >= 100 && value <= 900) weight = Math.round(value / 100) * 100;
    }
    if (!family) return null;
    const style = /italic|oblique/i.test(subfamily) ? "italic" : "normal";
    return { family, weight, style };
  } catch {
    return null;
  }
}

/** 注册一份字体字节；已存在则直接复用。返回记录。 */
export async function putFont(
  bytes: Uint8Array,
  fileName: string,
): Promise<{ ok: true; record: FontRecord } | { ok: false; reason: string }> {
  if (bytes.length === 0) return { ok: false, reason: t("error.emptyFont") };
  if (bytes.length > MAX_FONT_BYTES) return { ok: false, reason: t("error.fontTooLarge") };
  const total = [...records.values()].reduce((sum, record) => sum + record.bytes.length, 0);
  if (total + bytes.length > MAX_FONT_TOTAL) return { ok: false, reason: t("error.fontTotalTooLarge") };
  const mime = sniffFontMime(bytes);
  if (!mime) return { ok: false, reason: t("error.unsupportedFont") };

  const assetId = await fontIdFor(bytes);
  const existing = records.get(assetId);
  if (existing) return { ok: true, record: existing };

  const meta = parseFontMeta(bytes) ?? {
    family: fileName.replace(/\.[^.]+$/, "") || t("font.customFamily"),
    weight: 400,
    style: "normal" as const,
  };
  const url = URL.createObjectURL(new Blob([toBuffer(bytes)], { type: mime }));
  const record: FontRecord = { assetId, mime, url, bytes, ...meta };
  records.set(assetId, record);
  await registerRecord(record);
  return { ok: true, record };
}

/** 把一条字体注册进 `document.fonts`，画布与导出共用。 */
export async function registerRecord(record: FontRecord): Promise<void> {
  const key = `${record.family}|${record.weight}|${record.style}`;
  if (registered.has(key)) return;
  registered.add(key);
  try {
    const face = new FontFace(record.family, `url(${record.url})`, {
      weight: String(record.weight),
      style: record.style,
    });
    await face.load();
    document.fonts.add(face);
    faces.set(key, face);
  } catch {
    // 注册失败：文本回退到系统字体，不阻断导入；允许之后重试
    registered.delete(key);
  }
}

/** 打开文档后把文档里引用的字体都注册一遍。 */
export async function registerDocFonts(doc: DocState): Promise<void> {
  for (const entry of doc.fonts ?? []) {
    const record = records.get(entry.assetId);
    if (record) await registerRecord(record);
  }
}

/** 从 CSS font-family 栈里取第一个字族（去引号）；空栈返回空串。 */
export function firstFamilyOf(stack: string): string {
  const match = /^\s*['"]?([^'",]+)['"]?/.exec(stack);
  return match ? match[1].trim() : "";
}

/** 已导入的字族（检查器下拉用）。 */
export function fontFamilies(): string[] {
  return [...new Set([...records.values()].map((record) => record.family))].sort();
}

/** 某个字族实际有的字重档位。 */
export function fontWeightsOf(family: string): number[] {
  return [...new Set([...records.values()].filter((r) => r.family === family).map((r) => r.weight))].sort(
    (a, b) => a - b,
  );
}

export function allFonts(): FontRecord[] {
  return [...records.values()];
}

/** 文档实际用到的字体（按节点 fontFamily 栈的首个字族匹配，同族全部字重都保留）。 */
export function fontsForSave(doc: DocState): FontRecord[] {
  const used = new Set<string>();
  for (const node of Object.values(doc.nodes)) {
    const family = firstFamilyOf(node.style.fontFamily ?? "");
    if (family) used.add(family.toLowerCase());
  }
  if (used.size === 0) return [];
  return [...records.values()].filter((record) => used.has(record.family.toLowerCase()));
}

/** 文档里要记的字体表（只记引用，字节在 zip 里）。 */
export function fontTable(doc: DocState): FontEntry[] {
  return fontsForSave(doc).map(({ assetId, family, weight, style, mime }) => ({
    assetId,
    family,
    weight,
    style,
    mime,
  }));
}

/** 打开文件时把 zip 里的 fonts/ 注册进来（先不注册到 document.fonts，用到再说）。 */
export function loadFonts(files: Record<string, Uint8Array>): void {
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith("fonts/")) continue;
    const assetId = path.slice("fonts/".length).replace(/\.[^.]+$/, "");
    if (records.has(assetId)) continue;
    const mime = sniffFontMime(bytes);
    if (!mime) continue;
    const meta = parseFontMeta(bytes) ?? { family: assetId, weight: 400, style: "normal" as const };
    records.set(assetId, {
      assetId,
      mime,
      bytes,
      url: URL.createObjectURL(new Blob([toBuffer(bytes)], { type: mime })),
      ...meta,
    });
  }
}

/** 新建/关闭文档时清空。 */
export function resetFonts(): void {
  for (const face of faces.values()) document.fonts.delete(face);
  faces.clear();
  registered.clear();
  for (const record of records.values()) URL.revokeObjectURL(record.url);
  records.clear();
}

export type { NodeId };
