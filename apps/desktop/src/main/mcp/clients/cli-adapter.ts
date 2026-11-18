/**
 * CLI adapter：只负责「按固定 argv 调用官方命令」，不解析 list、不读回配置。
 *
 * 保底：找不到可执行文件就报 CLI_MISSING，绝不退化成直接改它的大配置文件；
 * 所有失败都带退出码或 stderr 摘要，方便日志与面板上的「先移除再接入」。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { McpClientId } from "../../../shared/mcp-clients";
import { backupClientConfig } from "./backup";
import { expandHome, resolveExecutable } from "./detect";
import { statOrNull } from "./fs";
import { logApp } from "../log";
import type { AttachOutcome, ClientAdapter, ClientContext, ClientIssue, ClientSnapshot } from "./types";

export interface CliAdapterSpec {
  id: McpClientId;
  binNames: readonly string[];
  /** 可能需要快照的配置文件（存在才备份） */
  snapshotPaths(ctx: ClientContext): string[];
  addArgs(url: string): string[];
  removeArgs(): string[];
}

export interface CliRunOptions {
  /** 测试注入更短的超时 */
  timeoutMs?: number;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type RunOutcome = { ok: true; run: RunResult } | { ok: false; issue: ClientIssue };

const OUTPUT_LIMIT = 4096;
const DEFAULT_TIMEOUT_MS = 5000;

/** cmd.exe 里单个参数的保守转义：只在必要时加引号，内部引号翻倍。 */
export function quoteWindowsArg(arg: string): string {
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Windows 批处理（`.cmd` / `.bat`）必须经 cmd.exe 执行：整条命令串要再包一层引号，
 * 并配 `windowsVerbatimArguments` 原样透传。否则 `/s` 会剥掉首个引号，
 * 含空格的 `.cmd` 路径会被判成"找不到命令"。
 */
export function buildWindowsCmdArgv(
  bin: string,
  args: string[],
): { command: string; argv: string[]; windowsVerbatimArguments: boolean } {
  const line = [bin, ...args].map(quoteWindowsArg).join(" ");
  return { command: "cmd.exe", argv: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

export function createCliAdapter(
  spec: CliAdapterSpec,
  ctx: ClientContext,
  options: CliRunOptions = {},
): ClientAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function executable(): Promise<Awaited<ReturnType<typeof resolveExecutable>>> {
    return resolveExecutable(spec.binNames, ctx);
  }

  async function detectImpl(): Promise<boolean> {
    if (await executable()) return true;
    for (const raw of spec.snapshotPaths(ctx)) {
      if (await statOrNull(expandHome(raw, ctx.home))) return true;
    }
    return false;
  }

  async function snapshot(): Promise<ClientIssue | null> {
    for (const raw of spec.snapshotPaths(ctx)) {
      const source = expandHome(raw, ctx.home);
      if (!(await statOrNull(source))) continue;
      try {
        await backupClientConfig({
          source,
          backupDir: join(ctx.userDataDir, "mcp-backups"),
          client: spec.id,
        });
      } catch (error) {
        return { code: "BACKUP_FAILED", detail: String(error) };
      }
    }
    return null;
  }

  async function run(args: string[]): Promise<RunOutcome> {
    const bin = await executable();
    if (!bin) return { ok: false, issue: { code: "CLI_MISSING", detail: spec.binNames.join(", ") } };
    try {
      return { ok: true, run: await spawnCommand(bin.path, bin.batch, args, ctx, timeoutMs) };
    } catch (error) {
      return { ok: false, issue: { code: "CLI_FAILED", detail: String(error) } };
    }
  }

  return {
    id: spec.id,
    channel: "cli",

    async detect(): Promise<boolean> {
      return detectImpl();
    },

    async inspect(): Promise<ClientSnapshot> {
      const detected = await detectImpl();
      return { detected, target: null, entry: "unknown", url: null, issue: null };
    },

    async attach(url: string): Promise<AttachOutcome> {
      const bin = await executable();
      if (!bin) {
        return { ok: false, issue: { code: "CLI_MISSING", detail: spec.binNames.join(", ") } };
      }
      const backupIssue = await snapshot();
      if (backupIssue) return { ok: false, issue: backupIssue };

      const started = Date.now();
      const outcome = await run(spec.addArgs(url));
      logApp("info", "client cli add", {
        client: spec.id,
        bin: bin.path,
        args: spec.addArgs(url),
        ok: outcome.ok,
        ms: Date.now() - started,
      });
      if (!outcome.ok) return { ok: false, issue: outcome.issue };
      if (outcome.run.code === 0) return { ok: true };
      return {
        ok: false,
        issue: { code: "CLI_FAILED", detail: failureDetail(outcome.run) },
      };
    },

    async detach(): Promise<AttachOutcome> {
      const bin = await executable();
      if (!bin) {
        return { ok: false, issue: { code: "CLI_MISSING", detail: spec.binNames.join(", ") } };
      }
      const backupIssue = await snapshot();
      if (backupIssue) return { ok: false, issue: backupIssue };

      const outcome = await run(spec.removeArgs());
      logApp("info", "client cli remove", {
        client: spec.id,
        bin: bin.path,
        args: spec.removeArgs(),
        ok: outcome.ok,
      });
      if (!outcome.ok) return { ok: false, issue: outcome.issue };
      if (outcome.run.code === 0) return { ok: true };
      // 条目本来就不在：各 CLI 的措辞不一，只能按关键字兜底
      if (/not found|no such|does not exist|not configured|no mcp server|unknown (server|mcp)/i.test(`${outcome.run.stderr}\n${outcome.run.stdout}`)) {
        return { ok: true };
      }
      return { ok: false, issue: { code: "CLI_FAILED", detail: failureDetail(outcome.run) } };
    },
  };
}

function failureDetail(run: RunResult): string {
  if (run.timedOut) return "timed out";
  const text = run.stderr.trim() || run.stdout.trim();
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-3);
  return lines.join(" / ").slice(0, 600) || `exit ${run.code ?? "unknown"}`;
}

async function spawnCommand(
  bin: string,
  batch: boolean,
  args: string[],
  ctx: ClientContext,
  timeoutMs: number,
): Promise<RunResult> {
  const isWin = ctx.platform === "win32";
  const win = isWin && batch ? buildWindowsCmdArgv(bin, args) : null;
  const command = win ? win.command : bin;
  const argv = win ? win.argv : args;

  return await new Promise<RunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, argv, {
      cwd: ctx.home,
      env: ctx.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: win?.windowsVerbatimArguments ?? false,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: tail(stdout), stderr: tail(stderr), timedOut });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-OUTPUT_LIMIT * 2);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_LIMIT * 2);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => finish(code));
  });
}

function tail(text: string): string {
  return text.length <= OUTPUT_LIMIT ? text : text.slice(-OUTPUT_LIMIT);
}

export function cliAdapters(ctx: ClientContext, options: CliRunOptions = {}): ClientAdapter[] {
  return [
    createCliAdapter(
      {
        id: "claude-code",
        binNames: ["claude"],
        snapshotPaths: () => [join(ctx.home, ".claude.json")],
        addArgs: (url) => ["mcp", "add", "--transport", "http", "sqraft", url, "--scope", "user"],
        removeArgs: () => ["mcp", "remove", "sqraft", "--scope", "user"],
      },
      ctx,
      options,
    ),
    createCliAdapter(
      {
        id: "codex",
        binNames: ["codex"],
        snapshotPaths: () => [join(ctx.home, ".codex", "config.toml")],
        addArgs: (url) => ["mcp", "add", "sqraft", "--url", url],
        removeArgs: () => ["mcp", "remove", "sqraft"],
      },
      ctx,
      options,
    ),
  ];
}
