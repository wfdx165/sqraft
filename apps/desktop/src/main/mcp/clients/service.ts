/**
 * 接入服务：把 adapter（写配置）、所有权清单（记住写过什么）与会话状态拼成 UI 要的四态。
 *
 * 这里只做编排，不直接碰文件；所有写入护栏在 adapter 与 fs 层。
 */
import { join } from "node:path";
import {
  type McpAttachResult,
  type McpClientInfo,
  type McpClientState,
  type McpClientsSnapshot,
  type McpClientIssueInfo,
} from "../../../shared/ipc";
import type { McpClientId, McpClientIssueCode } from "../../../shared/mcp-clients";
import type { MessageKey } from "../../../shared/i18n";
import { t } from "../../i18n";
import { logApp } from "../log";
import { createAdapters } from "./adapters";
import { createSerialQueue } from "./serial";
import { loadManifest, MANIFEST_FILENAME, removeClient, saveManifest, setClient } from "./manifest";
import type { ClientAdapter, ClientContext, ClientIssue, ClientSnapshot } from "./types";

export interface ClientServiceDeps {
  ctx: ClientContext;
  /** 当前端点；服务没起来时也返回偏好算出的地址 */
  url: () => string;
  listening: () => boolean;
  sessions: () => McpClientInfo[];
  now?: () => Date;
}

export interface ClientService {
  snapshot(): Promise<McpClientsSnapshot>;
  attach(id: McpClientId, mode?: "normal" | "replace"): Promise<McpAttachResult>;
  detach(id: McpClientId): Promise<McpAttachResult>;
  /** 端口变化后同步清单内条目；失败保留旧记录，交给 UI 显示「更新地址」 */
  sync(url?: string): Promise<{ updated: number; failed: number }>;
}

const ISSUE_KEYS: Record<McpClientIssueCode, MessageKey> = {
  CLI_MISSING: "mcp.issue.CLI_MISSING",
  CLI_FAILED: "mcp.issue.CLI_FAILED",
  CONFIG_UNPARSABLE: "mcp.issue.CONFIG_UNPARSABLE",
  CONFIG_UNEXPECTED_SHAPE: "mcp.issue.CONFIG_UNEXPECTED_SHAPE",
  TARGET_MISSING: "mcp.issue.TARGET_MISSING",
  VERIFY_FAILED: "mcp.issue.VERIFY_FAILED",
  BACKUP_FAILED: "mcp.issue.BACKUP_FAILED",
  WRITE_FAILED: "mcp.issue.WRITE_FAILED",
  CONFLICT: "mcp.issue.CONFLICT",
  SYNC_FAILED: "mcp.issue.SYNC_FAILED",
  SERVER_DOWN: "mcp.issue.SERVER_DOWN",
};

const RESTART_KEYS: Record<McpClientId, MessageKey> = {
  "claude-code": "mcp.restart.claudeCode",
  codex: "mcp.restart.codex",
  opencode: "mcp.restart.opencode",
  cursor: "mcp.restart.cursor",
  vscode: "mcp.restart.vscode",
  zed: "mcp.restart.zed",
};

/** 客户端自报的 label 不可完全信任：只做包含匹配，认不出就不归属。 */
const LABEL_MATCHERS: ReadonlyArray<readonly [McpClientId, RegExp]> = [
  ["claude-code", /claude/i],
  ["codex", /codex/i],
  ["opencode", /opencode/i],
  ["cursor", /cursor/i],
  ["vscode", /vscode|copilot/i],
  ["zed", /zed/i],
];

export function createClientService(
  deps: ClientServiceDeps,
  adapters: readonly ClientAdapter[] = createAdapters(deps.ctx),
): ClientService {
  const manifestFile = join(deps.ctx.userDataDir, MANIFEST_FILENAME);
  const queues = new Map<McpClientId, ReturnType<typeof createSerialQueue>>();
  /**
   * 清单是六个客户端共享的单文件，读-改-写必须跨客户端串行。
   * per-client 队列只保证同一客户端的配置写入顺序，挡不住 A/B 并发 attach 互相覆盖记录。
   */
  const manifestQueue = createSerialQueue();
  const now = deps.now ?? (() => new Date());

  function queueOf(id: McpClientId): ReturnType<typeof createSerialQueue> {
    let queue = queues.get(id);
    if (!queue) {
      queue = createSerialQueue();
      queues.set(id, queue);
    }
    return queue;
  }

  function issueInfo(issue: ClientIssue | null): McpClientIssueInfo | null {
    if (!issue) return null;
    return {
      code: issue.code,
      message: t(ISSUE_KEYS[issue.code]),
      detail: issue.detail ?? null,
      existing: issue.code === "CONFLICT" ? (issue.detail ?? null) : null,
    };
  }

  function sessionCounts(): Map<McpClientId, number> {
    const counts = new Map<McpClientId, number>();
    for (const session of deps.sessions()) {
      const match = LABEL_MATCHERS.find(([, pattern]) => pattern.test(session.label));
      if (match) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
    }
    return counts;
  }

  async function inspectAll(): Promise<Map<McpClientId, ClientSnapshot>> {
    const entries = await Promise.all(
      adapters.map(async (adapter) => {
        try {
          return [adapter.id, await adapter.inspect()] as const;
        } catch (error) {
          const issue: ClientIssue = { code: "WRITE_FAILED", detail: String(error) };
          return [
            adapter.id,
            { detected: false, target: null, entry: "unknown", url: null, issue } satisfies ClientSnapshot,
          ] as const;
        }
      }),
    );
    return new Map(entries);
  }

  async function snapshot(): Promise<McpClientsSnapshot> {
    const [manifest, seen] = await Promise.all([loadManifest(manifestFile), inspectAll()]);
    const counts = sessionCounts();
    const url = deps.url();
    const clients: McpClientState[] = adapters.map((adapter) => {
      const record = manifest.clients[adapter.id];
      const state = seen.get(adapter.id)!;
      const sessions = counts.get(adapter.id) ?? 0;
      const written =
        (record !== undefined &&
          record.url === url &&
          (adapter.channel === "cli" || (state.entry === "present" && state.url === url))) ||
        (adapter.channel === "file" && state.entry === "present" && state.url === url);
      const status: McpClientState["state"] =
        sessions > 0 ? "connected" : written ? "written" : state.detected || record ? "absent" : "undetected";
      const stale = record !== undefined && record.url !== url;
      return {
        id: adapter.id,
        detected: state.detected || record !== undefined,
        state: status,
        channel: adapter.channel,
        url: record?.url ?? state.url,
        target: state.target ?? record?.target ?? null,
        sessions,
        issue:
          issueInfo(state.issue) ??
          (stale ? issueInfo({ code: "SYNC_FAILED", detail: `${record.url} -> ${url}` }) : null),
        restartHint: status === "written" ? RESTART_KEYS[adapter.id] : null,
      };
    });
    return { listening: deps.listening(), url, clients };
  }

  async function attach(id: McpClientId, mode: "normal" | "replace" = "normal"): Promise<McpAttachResult> {
    const adapter = adapters.find((item) => item.id === id);
    if (!adapter) {
      throw new Error(`unknown mcp client: ${id}`);
    }
    return queueOf(id)(async () => {
      if (!deps.listening()) {
        const issue = issueInfo({ code: "SERVER_DOWN" });
        return { ok: false, snapshot: await snapshot(), restartHint: null, issue };
      }
      const url = deps.url();
      const manifest = await loadManifest(manifestFile);
      const previous = manifest.clients[id];
      const result = await adapter.attach(url, {
        owned: mode === "replace" || previous !== undefined,
      });
      if (!result.ok) {
        return { ok: false, snapshot: await snapshot(), restartHint: null, issue: issueInfo(result.issue) };
      }

      const seen = await adapter.inspect();
      try {
        // 锁内重新读取：并发 attach 另一个客户端时，不能拿旧快照覆盖它刚写进去的记录
        await manifestQueue(async () => {
          const current = await loadManifest(manifestFile);
          const stamp = now().toISOString();
          const record = {
            channel: adapter.channel,
            target: seen.target,
            entry: "sqraft",
            url,
            attachedAt: current.clients[id]?.attachedAt ?? stamp,
            lastSyncAt: stamp,
          };
          await saveManifest(manifestFile, setClient(current, id, record));
        });
      } catch (error) {
        // 配置已经写成功，清单失败只影响端口跟随；不能因此告诉用户"没接上"
        logApp("warn", "client manifest save failed", { client: id, error: String(error) });
      }
      logApp("info", "client attached", { client: id, channel: adapter.channel, target: seen.target, replace: mode === "replace" });
      return {
        ok: true,
        snapshot: await snapshot(),
        restartHint: RESTART_KEYS[id],
        issue: null,
      };
    });
  }

  return {
    snapshot,
    attach,

    async sync(url = deps.url()): Promise<{ updated: number; failed: number }> {
      if (!deps.listening()) return { updated: 0, failed: 0 };
      // 这里只用于判断哪些客户端漂移；真正的清单写入在锁内重读，避免覆盖并发 attach
      const manifest = await loadManifest(manifestFile);
      const synced: McpClientId[] = [];
      let failed = 0;
      for (const adapter of adapters) {
        const record = manifest.clients[adapter.id];
        if (!record || record.url === url) continue;
        const ok = await queueOf(adapter.id)(async () => {
          if (adapter.channel === "cli") {
            const removed = await adapter.detach();
            if (!removed.ok) return false;
          }
          const attached = await adapter.attach(url, { owned: true });
          if (attached.ok) return true;
          // CLI：把旧地址加回去，至少保持原来能用的状态
          if (adapter.channel === "cli") await adapter.attach(record.url, { owned: true });
          return false;
        });
        if (ok) {
          synced.push(adapter.id);
        } else {
          failed += 1;
          logApp("warn", "client sync failed", { client: adapter.id, from: record.url, to: url });
        }
      }
      if (synced.length > 0) {
        try {
          await manifestQueue(async () => {
            const current = await loadManifest(manifestFile);
            let next = current;
            const stamp = now().toISOString();
            for (const id of synced) {
              const record = current.clients[id];
              if (record) next = setClient(next, id, { ...record, url, lastSyncAt: stamp });
            }
            await saveManifest(manifestFile, next);
          });
        } catch (error) {
          logApp("warn", "client manifest save failed", { error: String(error) });
        }
      }
      const updated = synced.length;
      logApp("info", "client sync", { url, updated, failed });
      return { updated, failed };
    },

    async detach(id: McpClientId): Promise<McpAttachResult> {
      const adapter = adapters.find((item) => item.id === id);
      if (!adapter) throw new Error(`unknown mcp client: ${id}`);
      return queueOf(id)(async () => {
        const result = await adapter.detach();
        if (!result.ok) {
          return { ok: false, snapshot: await snapshot(), restartHint: null, issue: issueInfo(result.issue) };
        }
        try {
          await manifestQueue(async () => {
            const current = await loadManifest(manifestFile);
            await saveManifest(manifestFile, removeClient(current, id));
          });
        } catch (error) {
          logApp("warn", "client manifest save failed", { client: id, error: String(error) });
        }
        logApp("info", "client detached", { client: id });
        return { ok: true, snapshot: await snapshot(), restartHint: null, issue: null };
      });
    },
  };
}
