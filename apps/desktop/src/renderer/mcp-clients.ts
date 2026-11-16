/**
 * 接入配置的渲染层 store：快照、逐客户端操作与手动片段共用同一份状态。
 * 端口写操作仍留在 `mcp-setup.ts`，避免把两件事混在一起。
 */
import { reactive } from "vue";
import type { McpAttachResult, McpClientsSnapshot } from "../shared/ipc";
import type { McpClientId } from "../shared/mcp-clients";
import { t } from "./i18n";
import { showToast } from "./toast";

export const MCP_CLIENT_LABELS: Record<McpClientId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  vscode: "VS Code",
  zed: "Zed",
};

export const MCP_CLIENT_ORDER: readonly McpClientId[] = [
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "vscode",
  "zed",
];

export const mcpClientsUi = reactive({
  snapshot: null as McpClientsSnapshot | null,
  busy: null as McpClientId | null,
  /** 主进程返回的本地化错误（调用本身失败时也放这里） */
  error: "",
});

let pending: Promise<McpClientsSnapshot | null> | null = null;
let disposeSync: (() => void) | null = null;

/** 端口漂移后的主进程同步结果：只负责 toast 与刷新快照。 */
export function installMcpClientsSync(): () => void {
  disposeSync?.();
  const off = window.sqraft.mcp.onClientsSynced(({ updated, failed }) => {
    if (updated > 0) showToast(t("mcp.clients.synced", { count: updated }));
    if (failed > 0) showToast(t("mcp.clients.syncFailed", { count: failed }), "error");
    void mcpClients.ensure(true);
  });
  disposeSync = off;
  return () => {
    off();
    if (disposeSync === off) disposeSync = null;
  };
}

export const mcpClients = {
  ensure(force = false): Promise<McpClientsSnapshot | null> {
    if (!force && mcpClientsUi.snapshot) return Promise.resolve(mcpClientsUi.snapshot);
    if (pending) return pending;
    pending = window.sqraft.mcp
      .clients()
      .then((next) => {
        mcpClientsUi.snapshot = next;
        return next;
      })
      .catch((error: unknown) => {
        mcpClientsUi.error = errorText(error);
        return null;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  },

  attach(id: McpClientId): Promise<McpAttachResult | null> {
    return run(id, () => window.sqraft.mcp.attachClient(id));
  },

  detach(id: McpClientId): Promise<McpAttachResult | null> {
    return run(id, () => window.sqraft.mcp.detachClient(id));
  },

  replace(id: McpClientId): Promise<McpAttachResult | null> {
    return run(id, () => window.sqraft.mcp.replaceClient(id));
  },
};

async function run(
  id: McpClientId,
  call: () => Promise<McpAttachResult>,
): Promise<McpAttachResult | null> {
  mcpClientsUi.busy = id;
  mcpClientsUi.error = "";
  try {
    const result = await call();
    mcpClientsUi.snapshot = result.snapshot;
    if (!result.ok && result.issue) mcpClientsUi.error = result.issue.message;
    return result;
  } catch (error) {
    mcpClientsUi.error = errorText(error);
    return null;
  } finally {
    mcpClientsUi.busy = null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
