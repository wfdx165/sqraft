/**
 * 客户端接入的领域类型（主进程侧）。
 *
 * 这里只放「一个 adapter 需要遵守什么」，具体客户端的路径与命令在 02 / 03 落地。
 */
import type { McpClientChannel, McpClientId, McpClientIssueCode } from "../../../shared/mcp-clients";

export interface ClientIssue {
  code: McpClientIssueCode;
  /** 给日志与排障的原文摘要；UI 只按 code 本地化，不直接展示它 */
  detail?: string;
}

export type AttachOutcome = { ok: true } | { ok: false; issue: ClientIssue };

/** 配置里受管条目的现状；CLI 客户端读不到，只能返回 `unknown`。 */
export type ClientEntryState = "absent" | "present" | "unknown";

/** 只读快照：UI 的四态推导与冲突提示都从这里来。 */
export interface ClientSnapshot {
  detected: boolean;
  /** 实际会读写的配置文件；CLI 客户端或未检测到时为 null */
  target: string | null;
  entry: ClientEntryState;
  /** 现有条目的 url；没有条目或读不到时为 null */
  url: string | null;
  /** 解析失败、目标缺失等；正常时为 null */
  issue: ClientIssue | null;
}

/**
 * 一个客户端的接入实现。
 *
 * 纪律：所有路径与命令都由实现内部固定，方法不接受路径参数；
 * `attach` / `detach` 必须幂等，并且只动名为 `sqraft` 的那一条 entry。
 */
export interface ClientAdapter {
  readonly id: McpClientId;
  readonly channel: McpClientChannel;
  /** 配置目录/文件或 App 本体是否存在 */
  detect(): Promise<boolean>;
  /** 读受管条目现状（不修改任何东西） */
  inspect(): Promise<ClientSnapshot>;
  /** `owned` 来自所有权清单：决定旧地址能不能被自动覆盖 */
  attach(url: string, options?: { owned?: boolean }): Promise<AttachOutcome>;
  detach(): Promise<AttachOutcome>;
}

/** adapter 构造所需的上下文：测试注入临时 HOME，生产用真实环境。 */
export interface ClientContext {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** 应用数据目录（所有权清单与备份） */
  userDataDir: string;
}

/** 所有权清单的一条记录。 */
export interface ManagedClientRecord {
  channel: McpClientChannel;
  /** 文件 adapter 的目标路径；CLI 客户端没有稳定目标时为 null */
  target: string | null;
  entry: string;
  url: string;
  attachedAt: string;
  lastSyncAt: string;
}

export interface OwnershipManifest {
  version: 1;
  clients: Partial<Record<McpClientId, ManagedClientRecord>>;
}
