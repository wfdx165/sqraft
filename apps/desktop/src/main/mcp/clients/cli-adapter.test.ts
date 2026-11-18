import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdapters } from "./adapters";
import { buildWindowsCmdArgv, quoteWindowsArg } from "./cli-adapter";
import type { ClientAdapter, ClientContext } from "./types";

const URL = "http://127.0.0.1:7331/mcp";
const dirs: string[] = [];

interface Env {
  ctx: ClientContext;
  home: string;
  bin: string;
  log: string;
  claude: ClientAdapter;
  codex: ClientAdapter;
}

/** 假 CLI：把 cwd 与 argv 写进日志，按环境变量退出/报错/睡觉。 */
const SCRIPT = `#!/bin/sh
printf 'CWD:%s\\n' "$PWD" >> "$LOG"
for a in "$@"; do printf 'ARG:%s\\n' "$a" >> "$LOG"; done
if [ -n "$ERR" ]; then printf '%s\\n' "$ERR" >&2; fi
if [ -n "$SLEEP" ]; then /bin/sleep "$SLEEP"; fi
exit "\${EXIT_CODE:-0}"
`;

async function env(options: { bin?: string } = {}): Promise<Env> {
  const home = await mkdtemp(join(tmpdir(), "sqraft-cli-"));
  dirs.push(home);
  const bin = join(home, "bin");
  const log = join(home, "calls.log");
  await mkdir(bin);
  if (options.bin !== "none") {
    for (const name of options.bin ? [options.bin] : ["claude", "codex"]) {
      const file = join(bin, name);
      await writeFile(file, SCRIPT);
      await chmod(file, 0o755);
    }
  }
  const ctx: ClientContext = {
    home,
    platform: "darwin",
    env: { PATH: bin, LOG: log, HOME: home, EXIT_CODE: "0" },
    userDataDir: join(home, ".data"),
  };
  const all = createAdapters(ctx, { timeoutMs: 2000 });
  return {
    ctx,
    home,
    bin,
    log,
    claude: all.find((item) => item.id === "claude-code")!,
    codex: all.find((item) => item.id === "codex")!,
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CLI adapter", () => {
  it("Claude Code 的 argv、cwd 与 user scope", async () => {
    const e = await env();
    expect(await e.claude.attach(URL)).toEqual({ ok: true });
    const lines = (await readFile(e.log, "utf8")).trim().split("\n");
    expect(lines).toEqual([
      `CWD:${await realpath(e.home)}`,
      "ARG:mcp",
      "ARG:add",
      "ARG:--transport",
      "ARG:http",
      "ARG:sqraft",
      `ARG:${URL}`,
      "ARG:--scope",
      "ARG:user",
    ]);
  });

  it("Codex 的 argv", async () => {
    const e = await env();
    expect(await e.codex.attach(URL)).toEqual({ ok: true });
    const lines = (await readFile(e.log, "utf8")).trim().split("\n");
    expect(lines.slice(1)).toEqual(["ARG:mcp", "ARG:add", "ARG:sqraft", "ARG:--url", `ARG:${URL}`]);
  });

  it("非 0 退出返回 stderr 摘要", async () => {
    const e = await env();
    const ctx: ClientContext = { ...e.ctx, env: { ...e.ctx.env, EXIT_CODE: "1", ERR: "server already exists" } };
    const adapter = createAdapters(ctx).find((item) => item.id === "claude-code")!;
    const result = await adapter.attach(URL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code).toBe("CLI_FAILED");
      expect(result.issue.detail).toContain("server already exists");
    }
  });

  it("超时被杀掉", async () => {
    const e = await env();
    const ctx: ClientContext = { ...e.ctx, env: { ...e.ctx.env, SLEEP: "5" } };
    const adapter = createAdapters(ctx, { timeoutMs: 100 }).find((item) => item.id === "claude-code")!;
    const result = await adapter.attach(URL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code).toBe("CLI_FAILED");
      expect(result.issue.detail).toBe("timed out");
    }
  });

  it("找不到 CLI 时不碰配置文件", async () => {
    const e = await env({ bin: "none" });
    const config = join(e.home, ".claude.json");
    await writeFile(config, '{"mcpServers":{}}\n');
    const result = await e.claude.attach(URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("CLI_MISSING");
    expect(await readFile(config, "utf8")).toBe('{"mcpServers":{}}\n');
  });

  it("移除时条目本来就不在，视为成功", async () => {
    const e = await env();
    const ctx: ClientContext = {
      ...e.ctx,
      env: { ...e.ctx.env, EXIT_CODE: "1", ERR: "No MCP server named sqraft" },
    };
    const adapter = createAdapters(ctx).find((item) => item.id === "claude-code")!;
    expect(await adapter.detach()).toEqual({ ok: true });
  });

  it("调用前快照已有配置", async () => {
    const e = await env();
    const config = join(e.home, ".claude.json");
    await writeFile(config, '{"mcpServers":{}}\n');
    expect(await e.claude.attach(URL)).toEqual({ ok: true });
    const backups = await readdir(join(e.home, ".data", "mcp-backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toContain("claude-code-");
    expect(await readFile(join(e.home, ".data", "mcp-backups", backups[0]!), "utf8")).toBe(
      '{"mcpServers":{}}\n',
    );
  });

  it("找不到 CLI 时仍算检测到已有配置", async () => {
    const e = await env({ bin: "none" });
    expect(await e.claude.detect()).toBe(false);
    await writeFile(join(e.home, ".claude.json"), "{}");
    expect(await e.claude.detect()).toBe(true);
  });
});

describe("Windows 参数转义", () => {
  it("普通参数不加引号，含空格/元字符的加引号并翻倍内部引号", () => {
    expect(quoteWindowsArg("mcp")).toBe("mcp");
    expect(quoteWindowsArg("http://127.0.0.1:7331/mcp")).toBe("http://127.0.0.1:7331/mcp");
    expect(quoteWindowsArg("C:\\Program Files\\Sqraft\\x.exe")).toBe('"C:\\Program Files\\Sqraft\\x.exe"');
    expect(quoteWindowsArg('a"b')).toBe('"a""b"');
  });

  it("批处理命令整串再包一层引号，并原样透传", () => {
    const built = buildWindowsCmdArgv("C:\\Program Files\\claude.cmd", ["mcp", "add", "sqraft", "http://127.0.0.1:7331/mcp"]);
    expect(built.command).toBe("cmd.exe");
    expect(built.windowsVerbatimArguments).toBe(true);
    expect(built.argv.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    const line = built.argv[3]!;
    expect(line.startsWith('"')).toBe(true);
    expect(line.endsWith('"')).toBe(true);
    // 外层引号剥掉后，内部仍保留路径的引号
    expect(line.slice(1, -1)).toBe(
      '"C:\\Program Files\\claude.cmd" mcp add sqraft http://127.0.0.1:7331/mcp',
    );
  });
});
