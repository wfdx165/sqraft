/**
 * 更新协议（纯函数，不碰 Electron / 文件系统，可在 Node 下直接测试）：
 * `latest.json` 的形状校验、版本比较、下载地址白名单。
 *
 * 信任根只有 GitHub 仓库这一个：地址必须是 https，且主机属于 github.com
 * 或它的资产 CDN（`*.githubusercontent.com`，Release 资产会被重定向到那里）。
 */
import type { MessageKey, MessageParams } from "../../shared/i18n";

/** 清单校验失败：只携带文案 key 与参数，由调用方按界面语言翻译。 */
export class UpdateManifestError extends Error {
  constructor(
    readonly key: MessageKey,
    readonly params?: MessageParams,
  ) {
    super(key);
    this.name = "UpdateManifestError";
  }
}

/** 平台资产键：只承诺 macOS arm64（README 也这么写）。 */
export const MAC_ARM64_ASSET = "mac-arm64";
/** 同一版本的手动安装包，给"没装更新器"的用户与回滚用。 */
export const MAC_ARM64_DMG_ASSET = "mac-arm64-dmg";

export interface UpdateAsset {
  url: string;
  size?: number;
  sha256: string;
}

export interface LatestManifest {
  version: string;
  publishedAt: string | null;
  notes: string | null;
  assets: Record<string, UpdateAsset>;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/** 拆成三段数字 + 预发布串；非法段按 0 处理，保证比较不抛错。 */
function splitVersion(value: string): { numbers: number[]; pre: string } {
  const clean = value.trim().replace(/^v/i, "");
  const dash = clean.indexOf("-");
  const core = dash === -1 ? clean : clean.slice(0, dash);
  const pre = dash === -1 ? "" : clean.slice(dash + 1);
  const numbers = core.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return { numbers, pre };
}

/** 语义化比较：a 大于 b 返回 1，相等 0，小于 -1。正式版高于同号预发布版。 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre > right.pre ? 1 : -1;
}

/** 下载地址白名单：只允许 https + GitHub 自家域名（含资产 CDN）。 */
export function isTrustedUpdateUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "github.com" || (host.endsWith(".githubusercontent.com") && host.length > ".githubusercontent.com".length);
}

function asAsset(value: unknown): UpdateAsset | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url.trim() : "";
  const sha256 = typeof record.sha256 === "string" ? record.sha256.trim() : "";
  if (!url || !SHA256_PATTERN.test(sha256)) return null;
  if (!isTrustedUpdateUrl(url)) return null;
  const size = typeof record.size === "number" && record.size > 0 ? record.size : undefined;
  return size === undefined ? { url, sha256 } : { url, size, sha256 };
}

/**
 * 校验 `latest.json`。任何一项不合格都直接抛错而不是猜——
 * 更新链路出错的代价比"这次不更新"大得多。
 */
export function parseLatest(raw: unknown): LatestManifest {
  if (!raw || typeof raw !== "object") throw new UpdateManifestError("update.manifestNotObject");
  const record = raw as Record<string, unknown>;
  const version = typeof record.version === "string" ? record.version.trim() : "";
  if (!VERSION_PATTERN.test(version)) {
    throw new UpdateManifestError("update.manifestVersion", { value: String(record.version) });
  }

  const assetsRecord = record.assets;
  if (!assetsRecord || typeof assetsRecord !== "object") throw new UpdateManifestError("update.manifestAssets");
  const assets: Record<string, UpdateAsset> = {};
  for (const [key, value] of Object.entries(assetsRecord as Record<string, unknown>)) {
    const asset = asAsset(value);
    if (asset) assets[key] = asset;
  }
  if (!assets[MAC_ARM64_ASSET]) throw new UpdateManifestError("update.manifestAsset");

  const publishedAt = typeof record.publishedAt === "string" ? record.publishedAt : null;
  const notes = typeof record.notes === "string" && record.notes.trim() ? record.notes : null;
  return { version, publishedAt, notes, assets };
}
