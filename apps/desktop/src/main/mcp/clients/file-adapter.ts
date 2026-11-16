/**
 * 文件 adapter 的通用实现：一个客户端 = 一组固定候选路径 + 固定 entry 键 + 固定值形状。
 *
 * 所有写操作都走同一串护栏：选路径 → 读/解析 → 冲突判定 → 备份 → 原子写 → 回读校验 → 失败还原。
 * 任何一步不满足就放弃，原文一个字节不动。
 */
import { constants } from "node:fs";
import { access, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { McpClientId } from "../../../shared/mcp-clients";
import { backupClientConfig } from "./backup";
import { decideConflict } from "./conflict";
import { expandHome } from "./detect";
import { readTextIfExists, resolveWritePath, statOrNull, writeTextAtomic } from "./fs";
import { isPlainObject, parseConfig, removeEntry, setEntry, stringProp, valueAt } from "./jsonc";
import type { AttachOutcome, ClientAdapter, ClientContext, ClientIssue, ClientSnapshot } from "./types";

export interface FileAdapterSpec {
  id: McpClientId;
  /** 候选配置文件的绝对路径或 `~/…`；按优先级排列 */
  configPaths(ctx: ClientContext): string[];
  /** 受管条目的键路径（含 `sqraft`） */
  entryPath: readonly string[];
  /** 写进配置的值 */
  valueFor(url: string): unknown;
  /** App 安装路径：只用于「检测到但配置文件还没生成」的提示 */
  appPaths?(ctx: ClientContext): string[];
  /** 额外检测（例如 OpenCode 的 CLI 存在） */
  extraDetect?(ctx: ClientContext): Promise<boolean>;
  /** 多份配置并存时的选择规则；默认优先含受管条目的那个 */
  select?(candidates: readonly ConfigCandidate[]): ConfigCandidate | null;
}

export interface ConfigCandidate {
  path: string;
  /** 文件内容；文件不存在时为 null（父目录存在时可创建） */
  text: string | null;
  root: Record<string, unknown> | null;
  parseError: ClientIssue | null;
}

function truncate(value: string, limit = 300): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** 条目可能写成裸 URL 字符串，也可能是 `{ url }`；两种都认。 */
function urlOf(entry: unknown): string | null {
  if (typeof entry === "string") return entry || null;
  return stringProp(entry, "url");
}

export function createFileAdapter(spec: FileAdapterSpec, ctx: ClientContext): ClientAdapter {
  async function candidates(): Promise<ConfigCandidate[]> {
    const out: ConfigCandidate[] = [];
    for (const raw of spec.configPaths(ctx)) {
      const path = expandHome(raw, ctx.home);
      const file = await statOrNull(path);
      if (!file) {
        const parent = await statOrNull(dirname(path));
        if (!parent) continue;
      } else if (!file.isFile()) {
        continue;
      }
      const text = await readTextIfExists(path);
      if (text === null) {
        out.push({ path, text: null, root: null, parseError: null });
        continue;
      }
      const parsed = parseConfig(text);
      out.push({
        path,
        text,
        root: parsed.ok ? parsed.value : null,
        parseError: parsed.ok ? null : { code: parsed.code, detail: parsed.detail },
      });
    }
    return out;
  }

  function pick(list: readonly ConfigCandidate[]): ConfigCandidate | null {
    if (spec.select) return spec.select(list);
    return list.find((item) => item.root && valueAt(item.root, spec.entryPath) !== undefined) ?? list[0] ?? null;
  }

  async function detectedFrom(list: readonly ConfigCandidate[]): Promise<boolean> {
    if (list.length > 0) return true;
    if (spec.extraDetect && (await spec.extraDetect(ctx))) return true;
    if (spec.appPaths) {
      for (const path of spec.appPaths(ctx)) {
        if (await statOrNull(expandHome(path, ctx.home))) return true;
      }
    }
    return false;
  }

  async function detected(): Promise<boolean> {
    return detectedFrom(await candidates());
  }

  return {
    id: spec.id,
    channel: "file",

    detect: detected,

    async inspect(): Promise<ClientSnapshot> {
      const list = await candidates();
      const chosen = pick(list);
      if (!chosen) {
        // 复用上面已经扫过的候选，别为了一次 inspect 再 stat/parse 一遍
        const seen = await detectedFrom(list);
        return {
          detected: seen,
          target: null,
          entry: "unknown",
          url: null,
          issue: seen ? { code: "TARGET_MISSING", detail: "config directory not found" } : null,
        };
      }
      if (chosen.parseError) {
        return { detected: true, target: chosen.path, entry: "unknown", url: null, issue: chosen.parseError };
      }
      const entry = chosen.root ? valueAt(chosen.root, spec.entryPath) : undefined;
      return {
        detected: true,
        target: chosen.path,
        entry: entry === undefined ? "absent" : "present",
        url: entry === undefined ? null : urlOf(entry),
        issue: null,
      };
    },

    async attach(url: string, options: { owned?: boolean } = {}): Promise<AttachOutcome> {
      const chosen = pick(await candidates());
      if (!chosen) {
        return {
          ok: false,
          issue: {
            code: "TARGET_MISSING",
            detail: "no config directory (start the client once)",
          },
        };
      }
      if (chosen.parseError) return { ok: false, issue: chosen.parseError };

      const originalText = chosen.text;
      const text = originalText ?? "{}\n";
      const existing = chosen.root ? valueAt(chosen.root, spec.entryPath) : undefined;
      const action = decideConflict({
        exists: existing !== undefined,
        existingUrl: existing === undefined ? null : urlOf(existing),
        desiredUrl: url,
        owned: Boolean(options.owned),
      });
      if (action === "skip-same") return { ok: true };
      if (action === "conflict") {
        return {
          ok: false,
          issue: { code: "CONFLICT", detail: truncate(JSON.stringify(existing)) },
        };
      }

      if (originalText !== null && !(await writable(chosen.path))) {
        return { ok: false, issue: { code: "WRITE_FAILED", detail: "config is not writable" } };
      }

      if (originalText !== null) {
        try {
          await backupClientConfig({
            source: chosen.path,
            backupDir: join(ctx.userDataDir, "mcp-backups"),
            client: spec.id,
          });
        } catch (error) {
          return { ok: false, issue: { code: "BACKUP_FAILED", detail: String(error) } };
        }
      }

      const next = setEntry(text, spec.entryPath, spec.valueFor(url));
      if (!next.ok) return { ok: false, issue: { code: next.code, detail: next.detail } };

      // 读与写之间文件可能被外部改过：写前重读，内容变了就放弃，不覆盖用户的新改动
      if ((await readTextIfExists(chosen.path)) !== originalText) {
        return { ok: false, issue: { code: "WRITE_FAILED", detail: "config changed externally" } };
      }

      try {
        await writeTextAtomic(await resolveWritePath(chosen.path), next.value);
      } catch (error) {
        return { ok: false, issue: { code: "WRITE_FAILED", detail: String(error) } };
      }

      const verify = await verifyEntry(chosen.path, spec.entryPath, spec.valueFor(url));
      if (verify) return { ok: true };

      await restore(chosen.path, originalText);
      return { ok: false, issue: { code: "VERIFY_FAILED", detail: chosen.path } };
    },

    async detach(): Promise<AttachOutcome> {
      const chosen = pick(await candidates());
      if (!chosen || chosen.text === null) return { ok: true };
      if (chosen.parseError) return { ok: false, issue: chosen.parseError };
      if (!chosen.root || valueAt(chosen.root, spec.entryPath) === undefined) return { ok: true };
      if (!(await writable(chosen.path))) {
        return { ok: false, issue: { code: "WRITE_FAILED", detail: "config is not writable" } };
      }

      try {
        await backupClientConfig({
          source: chosen.path,
          backupDir: join(ctx.userDataDir, "mcp-backups"),
          client: spec.id,
        });
      } catch (error) {
        return { ok: false, issue: { code: "BACKUP_FAILED", detail: String(error) } };
      }

      const next = removeEntry(chosen.text, spec.entryPath);
      if (!next.ok) return { ok: false, issue: { code: next.code, detail: next.detail } };

      try {
        await writeTextAtomic(await resolveWritePath(chosen.path), next.value);
      } catch (error) {
        return { ok: false, issue: { code: "WRITE_FAILED", detail: String(error) } };
      }

      const parsed = parseConfig(next.value);
      const removed = parsed.ok && valueAt(parsed.value, spec.entryPath) === undefined;
      if (!removed) {
        await restore(chosen.path, chosen.text);
        return { ok: false, issue: { code: "VERIFY_FAILED", detail: chosen.path } };
      }
      if (parsed.ok && Object.keys(parsed.value).length === 0) {
        await rm(chosen.path, { force: true }).catch(() => {});
      }
      return { ok: true };
    },
  };
}

async function verifyEntry(path: string, entryPath: readonly string[], expected: unknown): Promise<boolean> {
  const text = await readTextIfExists(path);
  if (text === null) return false;
  const parsed = parseConfig(text);
  if (!parsed.ok) return false;
  const actual = valueAt(parsed.value, entryPath);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function restore(path: string, original: string | null): Promise<void> {
  try {
    if (original === null) {
      await rm(path, { force: true });
    } else {
      await writeTextAtomic(await resolveWritePath(path), original);
    }
  } catch {
    /* 还原失败只能留给日志与人工处理，不能覆盖原始错误 */
  }
}

/** 从候选里挑出「含 mcp.servers」或指定文件名的那份；OpenCode 用。 */
export function selectByEntry(
  entryPath: readonly string[],
  preferredBasename?: string,
): (candidates: readonly ConfigCandidate[]) => ConfigCandidate | null {
  return (list) => {
    const withEntry = list.find((item) => item.root && valueAt(item.root, entryPath) !== undefined);
    if (withEntry) return withEntry;
    const parent = entryPath.slice(0, -1);
    const withParent = list.find((item) => item.root && isPlainObject(valueAt(item.root, parent)));
    if (withParent) return withParent;
    return (
      list.find((item) => item.text !== null && basename(item.path) === preferredBasename) ??
      list.find((item) => item.text !== null) ??
      list[0] ??
      null
    );
  };
}
