import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileAdapters } from "./file-adapters";
import type { ClientAdapter, ClientContext } from "./types";

const URL = "http://127.0.0.1:7331/mcp";
const dirs: string[] = [];

interface Env {
  ctx: ClientContext;
  home: string;
  cursor: ClientAdapter;
  vscode: ClientAdapter;
  zed: ClientAdapter;
  opencode: ClientAdapter;
}

async function env(platform: NodeJS.Platform = "linux"): Promise<Env> {
  const home = await mkdtemp(join(tmpdir(), "sqraft-clients-"));
  dirs.push(home);
  const ctx: ClientContext = { home, platform, env: { PATH: "" }, userDataDir: join(home, ".data") };
  const all = createFileAdapters(ctx);
  const get = (id: string) => all.find((item) => item.id === id)!;
  return {
    ctx,
    home,
    cursor: get("cursor"),
    vscode: get("vscode"),
    zed: get("zed"),
    opencode: get("opencode"),
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Cursor（文件 adapter）", () => {
  it("目录存在时创建配置，entry 形状正确且权限 0600", async () => {
    const { home, cursor } = await env();
    await mkdir(join(home, ".cursor"));
    const file = join(home, ".cursor", "mcp.json");

    expect(await cursor.attach(URL)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mcpServers: { sqraft: { url: URL } } });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    const seen = await cursor.inspect();
    expect(seen).toMatchObject({ detected: true, target: file, entry: "present", url: URL, issue: null });
  });

  it("重复接入不重写内容", async () => {
    const { home, cursor } = await env();
    const file = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"));
    await cursor.attach(URL);
    const before = await readFile(file, "utf8");
    const first = await stat(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cursor.attach(URL);
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(first.mtimeMs);
  });

  it("断开只删自己那条，保留其它服务器", async () => {
    const { home, cursor } = await env();
    const file = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"));
    await writeFile(
      file,
      '{\n  "mcpServers": {\n    "other": { "url": "https://example.com/mcp" }\n  }\n}\n',
    );
    await cursor.attach(URL);
    expect(await cursor.detach()).toEqual({ ok: true });
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(parsed).toEqual({ mcpServers: { other: { url: "https://example.com/mcp" } } });
  });

  it("冲突条目不动，返回 CONFLICT", async () => {
    const { home, cursor } = await env();
    const file = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"));
    const original = '{"mcpServers":{"sqraft":{"url":"https://example.com/mcp"}}}\n';
    await writeFile(file, original);

    const result = await cursor.attach(URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("CONFLICT");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("清单外的 loopback 遗留条目会被认领覆盖", async () => {
    const { home, cursor } = await env();
    const file = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"));
    await writeFile(file, '{"mcpServers":{"sqraft":{"url":"http://127.0.0.1:7330/mcp"}}}\n');
    expect(await cursor.attach(URL)).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toContain(URL);
  });

  it("解析失败拒绝写入，原文不变", async () => {
    const { home, cursor } = await env();
    const file = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"));
    const original = "{ broken";
    await writeFile(file, original);
    const result = await cursor.attach(URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("CONFIG_UNPARSABLE");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("只读文件拒绝写入", async () => {
    const { home, cursor } = await env();
    const file = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"));
    const original = "{}\n";
    await writeFile(file, original);
    await chmod(file, 0o444);
    const result = await cursor.attach(URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("WRITE_FAILED");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it.skipIf(process.platform === "win32")("软链写到真实文件，链接保留", async () => {
    const { home, cursor } = await env();
    const dir = join(home, ".cursor");
    const real = join(home, "dotfiles-mcp.json");
    await mkdir(dir);
    await writeFile(real, "{}\n");
    const link = join(dir, "mcp.json");
    await symlink(real, link);

    expect(await cursor.attach(URL)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(real, "utf8"))).toEqual({ mcpServers: { sqraft: { url: URL } } });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(real);
  });

  it("目录不存在时不创建，报 TARGET_MISSING", async () => {
    const { home, cursor } = await env();
    const result = await cursor.attach(URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("TARGET_MISSING");
    expect(await readdir(join(home, ".cursor")).catch(() => null)).toBeNull();
  });
});

describe("VS Code（文件 adapter）", () => {
  it("写 Copilot 原生路径与 type:http 形状", async () => {
    const { home, vscode } = await env();
    await mkdir(join(home, ".copilot"));
    expect(await vscode.attach(URL)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(join(home, ".copilot", "mcp-config.json"), "utf8"))).toEqual({
      mcpServers: { sqraft: { type: "http", url: URL } },
    });
  });

  it("COPILOT_HOME 覆盖默认目录", async () => {
    const base = await env();
    const custom = join(base.home, "copilot-custom");
    await mkdir(custom);
    const ctx: ClientContext = { ...base.ctx, env: { COPILOT_HOME: custom } };
    const adapter = createFileAdapters(ctx).find((item) => item.id === "vscode")!;
    expect(await adapter.attach(URL)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(join(custom, "mcp-config.json"), "utf8"))).toEqual({
      mcpServers: { sqraft: { type: "http", url: URL } },
    });
  });
});

describe("Zed（JSONC 保留注释）", () => {
  it("写入后注释与其它设置原样保留", async () => {
    const { home, zed } = await env();
    const file = join(home, ".config", "zed", "settings.json");
    await mkdir(join(home, ".config", "zed"), { recursive: true });
    const original = '{\n  // 我的主题\n  "theme": "One Dark",\n  "vim_mode": true,\n}\n';
    await writeFile(file, original);

    expect(await zed.attach(URL)).toEqual({ ok: true });
    const next = await readFile(file, "utf8");
    expect(next).toContain("// 我的主题");
    expect(next).toContain('"vim_mode": true');
    expect(next).toContain('"context_servers"');
    expect(next).toContain(URL);
  });
});

describe("OpenCode（两份配置的选择）", () => {
  async function seed(envValue: Env, json: unknown, jsonc?: unknown): Promise<{ jsonPath: string; jsoncPath: string }> {
    const dir = join(envValue.home, ".config", "opencode");
    await mkdir(dir, { recursive: true });
    const jsonPath = join(dir, "opencode.json");
    const jsoncPath = join(dir, "opencode.jsonc");
    await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
    if (jsonc !== undefined) await writeFile(jsoncPath, `${JSON.stringify(jsonc, null, 2)}\n`);
    return { jsonPath, jsoncPath };
  }

  it("已有 sqraft 的文件优先", async () => {
    const base = await env();
    const { jsonPath, jsoncPath } = await seed(
      base,
      { mcp: { servers: {} } },
      { mcp: { servers: { sqraft: { type: "remote", url: "http://127.0.0.1:7330/mcp" } } } },
    );
    expect(await base.opencode.attach(URL, { owned: true })).toEqual({ ok: true });
    expect(await readFile(jsonPath, "utf8")).not.toContain(URL);
    expect(await readFile(jsoncPath, "utf8")).toContain(URL);
  });

  it("都没有 sqraft 时选含 mcp.servers 的那份", async () => {
    const base = await env();
    const { jsonPath, jsoncPath } = await seed(
      base,
      { provider: {} },
      { mcp: { servers: { other: { type: "remote", url: "https://example.com/mcp" } } } },
    );
    expect(await base.opencode.attach(URL)).toEqual({ ok: true });
    expect(await readFile(jsonPath, "utf8")).not.toContain(URL);
    expect(await readFile(jsoncPath, "utf8")).toContain(URL);
  });

  it("只有 jsonc 时写 jsonc", async () => {
    const base = await env();
    const dir = join(base.home, ".config", "opencode");
    await mkdir(dir, { recursive: true });
    const jsoncPath = join(dir, "opencode.jsonc");
    await writeFile(jsoncPath, "{}\n");
    expect(await base.opencode.attach(URL)).toEqual({ ok: true });
    expect(await readFile(jsoncPath, "utf8")).toContain(URL);
  });

  it("两份都没有 mcp.servers 时默认写 opencode.json", async () => {
    const base = await env();
    const { jsonPath } = await seed(base, { provider: {} }, { provider: {} });
    expect(await base.opencode.attach(URL)).toEqual({ ok: true });
    expect(await readFile(jsonPath, "utf8")).toContain(URL);
  });

  it("写入形状是 mcp.servers + type:remote", async () => {
    const base = await env();
    const dir = join(base.home, ".config", "opencode");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "opencode.json"), "{}\n");
    await base.opencode.attach(URL);
    expect(JSON.parse(await readFile(join(dir, "opencode.json"), "utf8"))).toEqual({
      mcp: { servers: { sqraft: { type: "remote", url: URL } } },
    });
  });
});

describe("检测", () => {
  it("配置目录存在即检测到", async () => {
    const { home, cursor } = await env();
    expect(await cursor.detect()).toBe(false);
    await mkdir(join(home, ".cursor"));
    expect(await cursor.detect()).toBe(true);
  });
});
