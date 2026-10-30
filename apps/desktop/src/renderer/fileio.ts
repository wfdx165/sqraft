/** .sqraft 文件格式：zip 容器（manifest + 快照 + 操作日志）。见 architecture.md §10。 */
import { strToU8, strFromU8, unzipSync, zip } from "fflate";
import { CURRENT_FORMAT_VERSION, migrateDoc, type DocState } from "@sqraft/core";

function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip(files, (err, data) => (err ? reject(err) : resolve(data))));
}

export async function serializeDoc(state: DocState): Promise<Uint8Array> {
  return zipAsync({
    "manifest.json": strToU8(
      JSON.stringify({ formatVersion: state.formatVersion ?? CURRENT_FORMAT_VERSION, app: "sqraft", version: "0.0.1" }),
    ),
    "doc.json": strToU8(JSON.stringify(state)),
    "ops.ndjson": new Uint8Array(0),
  });
}

export async function parseDoc(bytes: Uint8Array): Promise<DocState> {
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
  return migrateDoc(state, state.formatVersion ?? formatVersion);
}
