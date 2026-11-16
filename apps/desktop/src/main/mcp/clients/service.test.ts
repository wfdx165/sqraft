import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpClientId } from "../../../shared/mcp-clients";
import type { ClientAdapter, ClientSnapshot } from "./types";
import { createClientService, type ClientServiceDeps } from "./service";
import { emptyManifest, loadManifest, MANIFEST_FILENAME, saveManifest, setClient } from "./manifest";
import type { ManagedClientRecord } from "./types";

const URL = "http://127.0.0.1:7331/mcp";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class Fake implements ClientAdapter {
  channel: "file" | "cli" = "file";
  snapshot: ClientSnapshot = { detected: true, target: null, entry: "absent", url: null, issue: null };
  attachResult: Awaited<ReturnType<ClientAdapter["attach"]>> = { ok: true };
  detachResult: Awaited<ReturnType<ClientAdapter["detach"]>> = { ok: true };
  attachCalls: Array<{ url: string; owned?: boolean }> = [];
  failUrls = new Set<string>();

  constructor(readonly id: McpClientId) {}

  async detect(): Promise<boolean> {
    return this.snapshot.detected;
  }

  async inspect(): Promise<ClientSnapshot> {
    return this.snapshot;
  }

  async attach(url: string, options: { owned?: boolean } = {}) {
    this.attachCalls.push({ url, owned: options.owned });
    if (this.failUrls.has(url)) return { ok: false, issue: { code: "CLI_FAILED" as const, detail: "nope" } };
    if (this.attachResult.ok) {
      this.snapshot = { detected: true, target: "/tmp/config.json", entry: "present", url, issue: null };
    }
    return this.attachResult;
  }

  async detach() {
    if (this.detachResult.ok) this.snapshot = { ...this.snapshot, entry: "absent", url: null };
    return this.detachResult;
  }
}

async function setup(overrides: Partial<ClientServiceDeps> = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), "sqraft-service-"));
  dirs.push(userDataDir);
  const cursor = new Fake("cursor");
  const zed = new Fake("zed");
  const deps: ClientServiceDeps = {
    ctx: { home: userDataDir, platform: "linux", env: {}, userDataDir },
    url: () => URL,
    listening: () => true,
    sessions: () => [],
    ...overrides,
  };
  return { service: createClientService(deps, [cursor, zed]), deps, cursor, zed, userDataDir };
}

describe("接入服务", () => {
  it("四态：未检测到 / 未接入 / 已写入 / 已连接", async () => {
    const { deps } = await setup();
    const adapters: Fake[] = [];
    const cursor = new Fake("cursor");
    cursor.snapshot = { detected: false, target: null, entry: "unknown", url: null, issue: null };
    const zed = new Fake("zed");
    zed.snapshot = { detected: true, target: "/tmp/zed.json", entry: "present", url: URL, issue: null };
    adapters.push(cursor, zed);

    const svc = createClientService(
      {
        ...deps,
        sessions: () => [{ id: "c1", label: "c1 claude-code/2.1", connectedAt: 1 }],
      },
      adapters,
    );
    const snap = await svc.snapshot();
    expect(snap.clients.find((item) => item.id === "cursor")?.state).toBe("undetected");
    expect(snap.clients.find((item) => item.id === "zed")?.state).toBe("written");
  });

  it("会话 label 归属到客户端；认不出的不归属", async () => {
    const { deps } = await setup();
    const cursor = new Fake("cursor");
    const svc = createClientService(
      {
        ...deps,
        sessions: () => [
          { id: "c1", label: "c1 cursor/1.0", connectedAt: 1 },
          { id: "c2", label: "mystery", connectedAt: 2 },
        ],
      },
      [cursor],
    );
    const snap = await svc.snapshot();
    expect(snap.clients[0]).toMatchObject({ state: "connected", sessions: 1 });
  });

  it("接入成功写清单并刷新状态", async () => {
    const { service, cursor } = await setup();
    const result = await service.attach("cursor");
    expect(result.ok).toBe(true);
    expect(result.restartHint).toBe("mcp.restart.cursor");
    expect(cursor.attachCalls).toEqual([{ url: URL, owned: false }]);
    expect(result.snapshot.clients.find((item) => item.id === "cursor")?.state).toBe("written");
  });

  it("并发接入两个客户端，两份所有权记录都保留", async () => {
    const { service, userDataDir } = await setup();
    await Promise.all([service.attach("cursor"), service.attach("zed")]);
    const manifest = await loadManifest(join(userDataDir, MANIFEST_FILENAME));
    expect(manifest.clients.cursor?.url).toBe(URL);
    expect(manifest.clients.zed?.url).toBe(URL);
  });

  it("服务未启动时拒绝接入", async () => {
    const { service, cursor } = await setup({ listening: () => false });
    const result = await service.attach("cursor");
    expect(result.ok).toBe(false);
    expect(result.issue?.code).toBe("SERVER_DOWN");
    expect(cursor.attachCalls).toEqual([]);
  });

  it("冲突返回已有条目并保持未接入", async () => {
    const { service, cursor } = await setup();
    cursor.snapshot = {
      detected: true,
      target: "/tmp/cursor.json",
      entry: "present",
      url: "https://example.com/mcp",
      issue: null,
    };
    cursor.attachResult = { ok: false, issue: { code: "CONFLICT", detail: '{"url":"https://example.com/mcp"}' } };
    const result = await service.attach("cursor");
    expect(result.ok).toBe(false);
    expect(result.issue).toMatchObject({
      code: "CONFLICT",
      existing: '{"url":"https://example.com/mcp"}',
    });
    expect(result.snapshot.clients.find((item) => item.id === "cursor")?.state).toBe("absent");
  });

  it("替换模式强制 owned", async () => {
    const { service, cursor } = await setup();
    await service.attach("cursor", "replace");
    expect(cursor.attachCalls[0]?.owned).toBe(true);
  });

  it("断开后清单清空，状态回到未接入", async () => {
    const { service } = await setup();
    await service.attach("cursor");
    const result = await service.detach("cursor");
    expect(result.ok).toBe(true);
    expect(result.snapshot.clients.find((item) => item.id === "cursor")?.state).toBe("absent");
  });

  it("CLI 客户端没有文件条目时按清单显示已写入", async () => {
    const { deps } = await setup();
    const cli = new Fake("codex");
    cli.channel = "cli";
    cli.snapshot = { detected: true, target: null, entry: "unknown", url: null, issue: null };
    cli.attachResult = { ok: true };
    const svc = createClientService(deps, [cli]);
    await svc.attach("codex");
    const snap = await svc.snapshot();
    expect(snap.clients[0]).toMatchObject({ state: "written", channel: "cli" });
  });

  it("未知 id 直接抛错", async () => {
    const { service } = await setup();
    await expect(service.attach("bogus" as McpClientId)).rejects.toThrow(/unknown mcp client/);
  });
});

describe("端口跟随", () => {
  const oldUrl = "http://127.0.0.1:7330/mcp";

  function record(channel: "file" | "cli"): ManagedClientRecord {
    return {
      channel,
      target: channel === "cli" ? null : "/tmp/config.json",
      entry: "sqraft",
      url: oldUrl,
      attachedAt: "2026-11-16T00:00:00.000Z",
      lastSyncAt: "2026-11-16T00:00:00.000Z",
    };
  }

  it("只更新清单内且地址不同的条目", async () => {
    const { service, cursor, zed, userDataDir } = await setup();
    await saveManifest(join(userDataDir, MANIFEST_FILENAME), setClient(emptyManifest(), "cursor", record("file")));

    expect(await service.sync(URL)).toEqual({ updated: 1, failed: 0 });
    expect(cursor.attachCalls).toEqual([{ url: URL, owned: true }]);
    expect(zed.attachCalls).toEqual([]);
    expect((await loadManifest(join(userDataDir, MANIFEST_FILENAME))).clients.cursor?.url).toBe(URL);
  });

  it("地址相同就跳过", async () => {
    const { service, cursor, userDataDir } = await setup();
    const current = { ...record("file"), url: URL };
    await saveManifest(join(userDataDir, MANIFEST_FILENAME), setClient(emptyManifest(), "cursor", current));

    expect(await service.sync(URL)).toEqual({ updated: 0, failed: 0 });
    expect(cursor.attachCalls).toEqual([]);
  });

  it("CLI 失败时用旧地址回滚，清单保持不变", async () => {
    const { deps, userDataDir } = await setup();
    const codex = new Fake("codex");
    codex.channel = "cli";
    codex.failUrls.add(URL);
    await saveManifest(join(userDataDir, MANIFEST_FILENAME), setClient(emptyManifest(), "codex", record("cli")));
    const service = createClientService(deps, [codex]);

    expect(await service.sync(URL)).toEqual({ updated: 0, failed: 1 });
    expect(codex.attachCalls).toEqual([
      { url: URL, owned: true },
      { url: oldUrl, owned: true },
    ]);
    expect((await loadManifest(join(userDataDir, MANIFEST_FILENAME))).clients.codex?.url).toBe(oldUrl);
    expect((await service.snapshot()).clients[0]?.issue?.code).toBe("SYNC_FAILED");
  });

  it("服务未监听时什么都不做", async () => {
    const { service, cursor, userDataDir } = await setup({ listening: () => false });
    await saveManifest(join(userDataDir, MANIFEST_FILENAME), setClient(emptyManifest(), "cursor", record("file")));
    expect(await service.sync(URL)).toEqual({ updated: 0, failed: 0 });
    expect(cursor.attachCalls).toEqual([]);
  });
});
