/**
 * MCP 接入配置：算出 CLI 的真实路径、生成可直接粘贴的配置、把 CLI 装进 PATH。
 * 路径全部由主进程计算，渲染层只负责展示与复制。
 */
import { chmod, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { McpSetupInfo } from "../../shared/ipc";

export type { McpSetupInfo };

export function cliScriptPath(options: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return options.packaged
    ? join(options.resourcesPath, "bin", "sqraft-mcp.js")
    : resolve(options.appPath, "resources/bin/sqraft-mcp.js");
}

const CANDIDATE_DIRS = ["/usr/local/bin", join(homedir(), ".local", "bin")];

export function installTargetDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return join(process.env.APPDATA ?? homedir(), "npm");
  return CANDIDATE_DIRS[0];
}

/** 依次尝试候选目录，返回第一个可写的；都不可写时返回首选目录（由调用方处理失败）。 */
export async function writableInstallDir(
  candidates: string[] = CANDIDATE_DIRS,
): Promise<{ dir: string; writable: boolean }> {
  for (const dir of candidates) {
    try {
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `.sqraft-probe-${process.pid}`);
      await symlink("/", probe);
      await unlink(probe).catch(() => {});
      return { dir, writable: true };
    } catch {
      continue;
    }
  }
  return { dir: candidates[0], writable: false };
}

export interface InstallResult {
  ok: boolean;
  path?: string;
  message: string;
}

/**
 * 在目标目录建立 `sqraft-mcp` 软链。
 * 已指向同一脚本时视为成功；同名但不是本应用的链接则拒绝覆盖。
 */
export async function installCli(cliPath: string, dir: string): Promise<InstallResult> {
  const entry = join(dir, "sqraft-mcp");
  try {
    await mkdir(dir, { recursive: true });
    await chmod(cliPath, 0o755).catch(() => {});
    const existing = await lstat(entry).catch(() => null);
    if (existing) {
      if (existing.isSymbolicLink()) {
        const target = await readlink(entry);
        if (resolve(dirname(entry), target) === resolve(cliPath)) {
          return { ok: true, path: entry, message: `已经安装：${entry}` };
        }
        return { ok: false, message: `${entry} 已指向另一个文件，未覆盖。可以手动删除后重试。` };
      }
      return { ok: false, message: `${entry} 已存在且不是本应用创建，未覆盖。` };
    }
    await symlink(cliPath, entry);
    return { ok: true, path: entry, message: `已安装到 ${entry}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `安装失败：${reason}。可以把下面的命令直接粘进 agent 配置。` };
  }
}

export async function collectSetupInfo(options: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
}): Promise<McpSetupInfo> {
  const cliPath = cliScriptPath(options);
  const targetDir = installTargetDir(options.platform);
  const entry = join(targetDir, "sqraft-mcp");

  let installed = false;
  try {
    const info = await lstat(entry);
    installed = info.isSymbolicLink() && resolve(await readlink(entry)) === resolve(cliPath);
  } catch {
    installed = false;
  }

  // 未安装时直接用 node 跑脚本，不依赖文件的可执行位
  const command = installed ? "sqraft-mcp" : `node ${cliPath}`;
  return {
    cliPath,
    installed,
    installedPath: installed ? entry : null,
    targetDir,
    commandLine: `claude mcp add sqraft -- ${command}`,
    json: JSON.stringify(
      { mcpServers: { sqraft: { command: "node", args: [cliPath] } } },
      null,
      2,
    ),
  };
}
