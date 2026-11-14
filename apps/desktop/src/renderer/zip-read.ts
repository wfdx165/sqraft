/**
 * 打开 .sqraft 用的快速 zip 读取：直接按中央目录取条目。
 *
 * 大稿（几百张图、上 GB）打开时，`fflate.unzipSync` 的两笔开销占了大头：
 * - 所有条目逐个复制一遍（图片本来就是 `level: 0` 存储的，复制纯属浪费）；
 * - `doc.json` 用纯 JS inflate（几百 MB 要好几秒）。
 *
 * 这里改成：存储（method 0）条目直接返回原缓冲区的**零拷贝视图**；
 * 压缩（method 8）条目交给浏览器原生的 `DecompressionStream("deflate-raw")`。
 * 遇到不认识的情况（ZIP64、加密、其它压缩方法、结构对不上）一律返回 null，
 * 由调用方退回 `unzipSync`——这里只做快路径，不做第二个完整的 zip 实现。
 */

import { inflateSync } from "fflate";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** EOCD 固定 22 字节 + 最长 65535 字节注释 */
const EOCD_SEARCH = 22 + 0xffff;

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  dataOffset: number;
}

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - EOCD_SEARCH);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/** 列出条目；结构不认识时返回 null。 */
function listEntries(bytes: Uint8Array): Entry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  // ZIP64 的占位值：交给 fflate
  if (count === 0xffff || dirOffset === 0xffffffff) return null;

  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== CENTRAL_SIG) return null;
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (flags & 0x1) return null; // 加密
    if (method !== 0 && method !== 8) return null;
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) return null;
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // 数据起点要按**本地头**的文件名 / 扩展长度算（可能与中央目录里的不同）
    if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIG) return null;
    const dataOffset =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataOffset + compressedSize > view.byteLength) return null;
    entries.push({ name, method, compressedSize, dataOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") return inflateSync(data);
  // 数据是读进来的文件缓冲区的视图（普通 ArrayBuffer）；只收窄类型，不复制
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 读出全部条目：存储条目是 `bytes` 的零拷贝视图（与 `bytes` 同生命周期），压缩条目原生解压。
 * 返回 null 表示走不了快路径。
 */
export async function readZip(bytes: Uint8Array): Promise<Record<string, Uint8Array> | null> {
  const entries = listEntries(bytes);
  if (!entries) return null;
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    const raw = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    files[entry.name] = entry.method === 0 ? raw : await inflateRaw(raw);
  }
  return files;
}
