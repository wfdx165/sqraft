/** .sqraft 文件格式：zip 容器（manifest + 快照 + 操作日志 + 图片资源）。见 architecture.md §10。 */
import { strToU8, strFromU8, unzipSync, zip, type Zippable } from "fflate";
import { CURRENT_FORMAT_VERSION, migrateDoc, type DocState } from "@sqraft/core";

function zipAsync(files: Zippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip(files, (err, data) => (err ? reject(err) : resolve(data))));
}

export interface AssetEntry {
  /** zip 内路径，形如 `assets/<id>.png` */
  name: string;
  bytes: Uint8Array;
}

export async function serializeDoc(state: DocState, assets: readonly AssetEntry[] = []): Promise<Uint8Array> {
  const files: Zippable = {
    "manifest.json": strToU8(
      JSON.stringify({ formatVersion: state.formatVersion ?? CURRENT_FORMAT_VERSION, app: "sqraft", version: "0.0.1" }),
    ),
    "doc.json": strToU8(JSON.stringify(state)),
    "ops.ndjson": new Uint8Array(0),
  };
  for (const asset of assets) {
    // PNG/JPEG 已经是压缩格式，再 deflate 只费 CPU 不省体积
    files[asset.name] = [asset.bytes, { level: 0 }];
  }
  return zipAsync(files);
}

export interface ParsedDoc {
  state: DocState;
  /** 原始条目表：`assets/` 下的字节交给资源仓库注册 */
  files: Record<string, Uint8Array>;
}

export async function parseDoc(bytes: Uint8Array): Promise<ParsedDoc> {
  const files = unzipSync(bytes);
  const docEntry = files["doc.json"];
  if (!docEntry) throw new Error("不是有效的 .sqraft 文件：缺少 doc.json");
  let formatVersion = 1;
  const manifest = files["manifest.json"];
  if (manifest) {
    try {
      const parsed = JSON.parse(strFromU8(manifest)) as { formatVersion?: number };
      formatVersion = parsed.formatVersion ?? 1;
    } catch {
      formatVersion = 1;
    }
  }
  const state = JSON.parse(strFromU8(docEntry)) as DocState;
  return { state: migrateDoc(state, state.formatVersion ?? formatVersion), files };
}

