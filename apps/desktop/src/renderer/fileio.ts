/** .sqraft 文件格式：zip 容器（manifest + 快照 + 操作日志 + 图片资源）。见 architecture.md §10。 */
import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from "fflate";
import { CURRENT_FORMAT_VERSION, migrateDoc, type DocState } from "@sqraft/core";

export interface AssetEntry {
  /** zip 内路径，形如 `assets/<id>.png` */
  name: string;
  bytes: Uint8Array;
}

export async function serializeDoc(
  state: DocState,
  assets: readonly AssetEntry[] = [],
  appVersion = "unknown",
): Promise<Uint8Array> {
  const files: Zippable = {
    "manifest.json": strToU8(
      JSON.stringify({
        formatVersion: state.formatVersion ?? CURRENT_FORMAT_VERSION,
        app: "sqraft",
        version: appVersion,
      }),
    ),
    "doc.json": strToU8(JSON.stringify(state)),
    "ops.ndjson": new Uint8Array(0),
  };
  for (const asset of assets) {
    // PNG/JPEG 已经是压缩格式，再 deflate 只费 CPU 不省体积
    files[asset.name] = [asset.bytes, { level: 0 }];
  }
  // 必须用 zipSync（与读路径的 unzipSync 对称）：async zip 对 ≥160KB 的条目
  // 走 blob-URL Web Worker，打包版 CSP 只放行 'self'，worker 拉不起来时
  // fflate 不报错也不回调，promise 永远不 settle——保存静默挂死（连带关不掉窗口）。
  return zipSync(files);
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
  const declared = Math.max(state.formatVersion ?? formatVersion, formatVersion);
  // 格式版本只降不升：老版本读新文件必须明确拒绝，而不是"尽量解析"出一份坏稿（ADR-0029）
  if (declared > CURRENT_FORMAT_VERSION) {
    throw new Error(
      `这份设计稿由更新版本的 Sqraft 创建（文件格式 v${declared}，当前支持 v${CURRENT_FORMAT_VERSION}）。请升级 Sqraft 后再打开。`,
    );
  }
  return { state: migrateDoc(state, declared), files };
}

