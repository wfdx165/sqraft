/**
 * 所有权清单：`userData/mcp-clients.json`。
 *
 * 只记「我们写过什么」，不记文件内容与凭据。清单损坏时按空清单处理——
 * 端口跟随少做一次不会坏，启动失败才是灾难。
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isMcpClientId, MCP_CLIENT_IDS, type McpClientId } from "../../../shared/mcp-clients";
import { readTextIfExists, writeTextAtomic } from "./fs";
import type { ManagedClientRecord, OwnershipManifest } from "./types";

export const MANIFEST_VERSION = 1;

export const MANIFEST_FILENAME = "mcp-clients.json";

export function emptyManifest(): OwnershipManifest {
  return { version: MANIFEST_VERSION, clients: {} };
}

/** 只接受认识的形状：多余字段丢弃，单条坏记录不影响其它客户端。 */
export function sanitizeManifest(value: unknown): OwnershipManifest {
  if (!value || typeof value !== "object") return emptyManifest();
  const raw = value as { version?: unknown; clients?: unknown };
  if (raw.version !== MANIFEST_VERSION) return emptyManifest();
  if (!raw.clients || typeof raw.clients !== "object") return emptyManifest();
  const clients: Partial<Record<McpClientId, ManagedClientRecord>> = {};
  for (const id of MCP_CLIENT_IDS) {
    const entry = (raw.clients as Record<string, unknown>)[id];
    const record = sanitizeRecord(entry);
    if (record) clients[id] = record;
  }
  return { version: MANIFEST_VERSION, clients };
}

function sanitizeRecord(value: unknown): ManagedClientRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const { channel, target, entry, url, attachedAt, lastSyncAt } = raw;
  if (channel !== "cli" && channel !== "file") return null;
  if (target !== null && typeof target !== "string") return null;
  if (typeof entry !== "string" || !entry || typeof url !== "string" || !url) return null;
  if (typeof attachedAt !== "string" || !attachedAt || typeof lastSyncAt !== "string" || !lastSyncAt) return null;
  return { channel, target, entry, url, attachedAt, lastSyncAt };
}

export async function loadManifest(file: string): Promise<OwnershipManifest> {
  const text = await readTextIfExists(file);
  if (text === null) return emptyManifest();
  try {
    return sanitizeManifest(JSON.parse(text) as unknown);
  } catch {
    return emptyManifest();
  }
}

export async function saveManifest(file: string, manifest: OwnershipManifest): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeTextAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export function setClient(
  manifest: OwnershipManifest,
  id: McpClientId,
  record: ManagedClientRecord,
): OwnershipManifest {
  return { version: MANIFEST_VERSION, clients: { ...manifest.clients, [id]: record } };
}

export function removeClient(manifest: OwnershipManifest, id: McpClientId): OwnershipManifest {
  const clients = { ...manifest.clients };
  delete clients[id];
  return { version: MANIFEST_VERSION, clients };
}

export function isManaged(manifest: OwnershipManifest, id: McpClientId): boolean {
  return Boolean(isMcpClientId(id) && manifest.clients[id]);
}
