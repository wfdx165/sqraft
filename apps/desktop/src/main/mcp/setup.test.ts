import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliScriptPath, collectSetupInfo, inspectEntry, installCli, installTargetDir } from "./setup";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-setup-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CLI 路径", () => {
  it("打包后从 resources 取，开发态从应用目录取", () => {
    expect(
      cliScriptPath({ packaged: true, resourcesPath: "/App/Resources", appPath: "/repo/apps/desktop" }),
    ).toBe("/App/Resources/bin/sqraft-mcp");
    expect(
      cliScriptPath({ packaged: false, resourcesPath: "/App/Resources", appPath: "/repo/apps/desktop" }),
    ).toBe("/repo/apps/desktop/resources/bin/sqraft-mcp");
  });

  it("未安装时命令行用 node 运行脚本", async () => {
    const info = await collectSetupInfo({
      packaged: true,
      resourcesPath: "/App/Resources",
      appPath: "/repo/apps/desktop",
    });
    expect(info.commandLine).toBe("claude mcp add sqraft -- node /App/Resources/bin/sqraft-mcp");
    expect(info.opencodeCommand).toBe(
      "opencode mcp add sqraft --global -- node /App/Resources/bin/sqraft-mcp",
    );
  });

  it("两套 JSON 各自符合客户端形状", async () => {
    const info = await collectSetupInfo({
      packaged: true,
      resourcesPath: "/App/Resources",
      appPath: "/repo/apps/desktop",
    });
    expect(JSON.parse(info.json)).toEqual({
      mcpServers: { sqraft: { command: "node", args: ["/App/Resources/bin/sqraft-mcp"] } },
    });
    expect(JSON.parse(info.opencodeJson)).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        servers: { sqraft: { type: "local", command: ["node", "/App/Resources/bin/sqraft-mcp"] } },
      },
    });
  });

  it("Windows 默认装到 npm 目录，其余平台装到 /usr/local/bin", () => {
    expect(installTargetDir("win32")).toContain("npm");
    expect(installTargetDir("darwin")).toBe("/usr/local/bin");
    expect(installTargetDir("linux")).toBe("/usr/local/bin");
  });
});

describe.skipIf(process.platform === "win32")("安装命令行工具", () => {
  it("建立指向 CLI 的软链", async () => {
    const dir = await tempDir();
    const cli = join(dir, "sqraft-mcp-cli");
    await writeFile(cli, "#!/usr/bin/env node\n");
    const result = await installCli(cli, join(dir, "bin"));
    expect(result.ok).toBe(true);
    const entry = join(dir, "bin", "sqraft-mcp");
    expect((await lstat(entry)).isSymbolicLink()).toBe(true);
    expect(resolve(await readlink(entry))).toBe(resolve(cli));
  });

  it("重复安装是幂等的", async () => {
    const dir = await tempDir();
    const cli = join(dir, "sqraft-mcp-cli");
    await writeFile(cli, "#!/usr/bin/env node\n");
    await installCli(cli, dir);
    const again = await installCli(cli, dir);
    expect(again.ok).toBe(true);
  });

  it("同名但不是本应用的入口时拒绝覆盖", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "sqraft-mcp"), "someone else\n");
    const result = await installCli(join(dir, "sqraft-mcp-cli"), dir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("未覆盖");
  });
});

/** 造一份"改名后"的应用 bin 目录：新旧两个文件名都真实存在。 */
async function makeAppBin(dir: string): Promise<{ current: string; legacy: string }> {
  const bin = join(dir, "Resources", "bin");
  await mkdir(bin, { recursive: true });
  const current = join(bin, "sqraft-mcp");
  const legacy = join(bin, "sqraft-mcp.js");
  await writeFile(current, "#!/usr/bin/env node\n");
  await writeFile(legacy, "#!/usr/bin/env node\n");
  return { current, legacy };
}

describe.skipIf(process.platform === "win32")("软链现状判定", () => {
  it("没装时是 absent", async () => {
    const dir = await tempDir();
    expect(await inspectEntry(join(dir, "sqraft-mcp"), join(dir, "cli"))).toBe("absent");
  });

  it("指向当前 CLI 时是 current", async () => {
    const dir = await tempDir();
    const { current } = await makeAppBin(dir);
    const entry = join(dir, "target");
    await symlink(current, entry);
    expect(await inspectEntry(entry, current)).toBe("current");
  });

  it("指向本应用 bin 里的旧 sqraft-mcp.js 时是 stale", async () => {
    const dir = await tempDir();
    const { current, legacy } = await makeAppBin(dir);
    const entry = join(dir, "target");
    await symlink(legacy, entry);
    expect(await inspectEntry(entry, current)).toBe("stale");
  });

  it("指向别处时是 foreign", async () => {
    const dir = await tempDir();
    const { current } = await makeAppBin(dir);
    const other = join(dir, "other", "sqraft-mcp");
    await mkdir(join(dir, "other"));
    await writeFile(other, "#!/usr/bin/env node\n");
    const entry = join(dir, "target");
    await symlink(other, entry);
    expect(await inspectEntry(entry, current)).toBe("foreign");
  });
});

describe.skipIf(process.platform === "win32")("旧版 CLI 链接的迁移", () => {
  it("面板先报未安装，安装后把旧链接换成新链接", async () => {
    const dir = await tempDir();
    const { current, legacy } = await makeAppBin(dir);
    const targetDir = join(dir, "target");
    await mkdir(targetDir, { recursive: true });
    const entry = join(targetDir, "sqraft-mcp");
    await symlink(legacy, entry);

    const before = await collectSetupInfo({
      packaged: true,
      resourcesPath: join(dir, "Resources"),
      appPath: dir,
      targetDir,
    });
    // 旧链接指向已删掉的文件：必须当成"未安装"，否则用户永远看不到安装入口
    expect(before.installed).toBe(false);
    expect(before.commandLine).toContain("node ");

    const result = await installCli(current, targetDir);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("已更新");
    expect(resolve(await readlink(entry))).toBe(resolve(current));

    const after = await collectSetupInfo({
      packaged: true,
      resourcesPath: join(dir, "Resources"),
      appPath: dir,
      targetDir,
    });
    expect(after.installed).toBe(true);
  });

  it("指向别处的链接仍然拒绝覆盖，且原链接不动", async () => {
    const dir = await tempDir();
    const { current } = await makeAppBin(dir);
    const other = join(dir, "other-mcp");
    await writeFile(other, "#!/usr/bin/env node\n");
    const entry = join(dir, "sqraft-mcp");
    await symlink(other, entry);

    const result = await installCli(current, dir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("未覆盖");
    expect(resolve(await readlink(entry))).toBe(resolve(other));
  });
});
