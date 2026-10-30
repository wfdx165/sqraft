import { lstat, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliScriptPath, collectSetupInfo, installCli, installTargetDir } from "./setup";

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
    ).toBe("/App/Resources/bin/sqraft-mcp.js");
    expect(
      cliScriptPath({ packaged: false, resourcesPath: "/App/Resources", appPath: "/repo/apps/desktop" }),
    ).toBe("/repo/apps/desktop/resources/bin/sqraft-mcp.js");
  });

  it("未安装时命令行用 node 运行脚本", async () => {
    const info = await collectSetupInfo({
      packaged: true,
      resourcesPath: "/App/Resources",
      appPath: "/repo/apps/desktop",
    });
    expect(info.commandLine).toBe("claude mcp add sqraft -- node /App/Resources/bin/sqraft-mcp.js");
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
    const cli = join(dir, "sqraft-mcp.js");
    await writeFile(cli, "#!/usr/bin/env node\n");
    const result = await installCli(cli, join(dir, "bin"));
    expect(result.ok).toBe(true);
    const entry = join(dir, "bin", "sqraft-mcp");
    expect((await lstat(entry)).isSymbolicLink()).toBe(true);
    expect(resolve(await readlink(entry))).toBe(resolve(cli));
  });

  it("重复安装是幂等的", async () => {
    const dir = await tempDir();
    const cli = join(dir, "sqraft-mcp.js");
    await writeFile(cli, "#!/usr/bin/env node\n");
    await installCli(cli, dir);
    const again = await installCli(cli, dir);
    expect(again.ok).toBe(true);
  });

  it("同名但不是本应用的入口时拒绝覆盖", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "sqraft-mcp"), "someone else\n");
    const result = await installCli(join(dir, "sqraft-mcp.js"), dir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("未覆盖");
  });
});
