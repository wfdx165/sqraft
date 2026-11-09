import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSetupInfo, inspectEntry, legacyCliPath, removeStaleCliLink } from "./setup";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-setup-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MCP 接入片段", () => {
  const info = collectSetupInfo({
    url: "http://127.0.0.1:7331/mcp",
    listening: true,
    port: 7331,
    explicitPort: null,
    driftFrom: null,
    error: null,
  });

  it("Claude Code 用 --transport http，其余客户端只放 URL", () => {
    expect(info.commandLine).toBe("claude mcp add --transport http sqraft http://127.0.0.1:7331/mcp");
    expect(JSON.parse(info.cursorJson)).toEqual({
      mcpServers: { sqraft: { url: "http://127.0.0.1:7331/mcp" } },
    });
    expect(JSON.parse(info.opencodeJson)).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        servers: { sqraft: { type: "remote", url: "http://127.0.0.1:7331/mcp" } },
      },
    });
  });

  it("把状态字段原样带出去（渲染层据此显示告警）", () => {
    const drifted = collectSetupInfo({
      url: "http://127.0.0.1:7332/mcp",
      listening: true,
      port: 7332,
      explicitPort: null,
      driftFrom: 7331,
      error: null,
    });
    expect(drifted.port).toBe(7332);
    expect(drifted.driftFrom).toBe(7331);
  });

  it("启动失败时仍给出地址，并带上原因", () => {
    const failed = collectSetupInfo({
      url: "http://127.0.0.1:7331/mcp",
      listening: false,
      port: null,
      explicitPort: 7331,
      driftFrom: null,
      error: "端口 7331 被占用",
    });
    expect(failed.listening).toBe(false);
    expect(failed.error).toContain("7331");
    expect(failed.url).toBe("http://127.0.0.1:7331/mcp");
  });
});

describe("旧 CLI 软链迁移", () => {
  const options = {
    packaged: true,
    resourcesPath: "/App/Resources",
    appPath: "/repo/apps/desktop",
  };

  it("打包后指 resources/bin，开发态指应用目录", () => {
    expect(legacyCliPath(options)).toBe("/App/Resources/bin/sqraft-mcp");
    expect(legacyCliPath({ ...options, packaged: false })).toBe(
      "/repo/apps/desktop/resources/bin/sqraft-mcp",
    );
  });

  it("只有指向本应用旧 CLI 的软链算残留", async () => {
    const dir = await tempDir();
    const cli = join(dir, "sqraft-mcp");
    const entry = join(dir, "bin-link");
    expect(await inspectEntry(entry, cli)).toBe("absent");

    await symlink(cli, entry);
    expect(await inspectEntry(entry, cli)).toBe("current");

    await rm(entry);
    await symlink(join(dir, "sqraft-mcp.js"), entry);
    expect(await inspectEntry(entry, cli)).toBe("stale");

    await rm(entry);
    const foreign = join(dir, "foreign");
    await writeFile(foreign, "#!/bin/sh\n");
    await symlink(foreign, entry);
    expect(await inspectEntry(entry, cli)).toBe("foreign");
  });

  it("清理只删本应用留下的链接，普通文件与外部链接不动", async () => {
    const dir = await tempDir();
    const oldCli = join(dir, "AppResources", "bin", "sqraft-mcp");
    const installDir = join(dir, "usr-local-bin");
    await mkdir(installDir, { recursive: true });

    const stale = join(installDir, "sqraft-mcp");
    await symlink(oldCli, stale);

    const foreignDir = join(dir, "foreign-dir");
    await mkdir(foreignDir);
    const foreign = join(foreignDir, "sqraft-mcp");
    await symlink("/usr/bin/true", foreign);

    const removed = await removeStaleCliLink({
      ...options,
      resourcesPath: join(dir, "AppResources"),
      dirs: [installDir, foreignDir],
    });
    expect(removed).toEqual([stale]);
    expect(await inspectEntry(stale, oldCli)).toBe("absent");
    expect(await inspectEntry(foreign, oldCli)).toBe("foreign");
  });
});
