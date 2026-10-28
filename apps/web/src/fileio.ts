/** .sqraft 文件读写：zip 容器（manifest + 快照 + 操作日志）。见 architecture.md §10。 */
import { strToU8, strFromU8, unzip, zip } from "fflate";
import type { DocState } from "@sqraft/core";

function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip(files, (err, data) => (err ? reject(err) : resolve(data))));
}

export async function serializeDoc(state: DocState): Promise<Uint8Array> {
  return zipAsync({
    "manifest.json": strToU8(JSON.stringify({ formatVersion: 1, app: "sqraft", version: "0.0.1" })),
    "doc.json": strToU8(JSON.stringify(state)),
    "ops.ndjson": new Uint8Array(0),
  });
}

export async function parseDoc(bytes: Uint8Array): Promise<DocState> {
  const files = await unzip(bytes);
  const docEntry = files["doc.json"];
  if (!docEntry) throw new Error("不是有效的 .sqraft 文件：缺少 doc.json");
  return JSON.parse(strFromU8(docEntry)) as DocState;
}

export async function saveWithPicker(state: DocState): Promise<void> {
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
  const bytes = await serializeDoc(state);
  if (w.showSaveFilePicker) {
    const handle = await w.showSaveFilePicker({ suggestedName: "untitled.sqraft", types: [{ description: "Sqraft 设计文件", accept: { "application/zip": [".sqraft"] } }] });
    const writable = await (handle as unknown as { createWritable(): Promise<WritableStream> }).createWritable();
    const writer = (writable as unknown as { write(b: Uint8Array): Promise<void>; close(): Promise<void> });
    await writer.write(bytes);
    await writer.close();
    return;
  }
  // 降级：下载
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "untitled.sqraft";
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function openWithPicker(): Promise<DocState | null> {
  const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> };
  if (w.showOpenFilePicker) {
    const [handle] = await w.showOpenFilePicker({ types: [{ description: "Sqraft 设计文件", accept: { "application/zip": [".sqraft"] } }] });
    const file = await (handle as unknown as { getFile(): Promise<File> }).getFile();
    return parseDoc(new Uint8Array(await file.arrayBuffer()));
  }
  // 降级：input 上传
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sqraft";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve(await parseDoc(new Uint8Array(await file.arrayBuffer())));
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}
