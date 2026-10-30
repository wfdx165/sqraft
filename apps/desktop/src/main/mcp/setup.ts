/**
 * MCP 接入配置：算出 CLI 的真实路径、生成可直接粘贴的配置、把 CLI 装进 PATH。
 * 路径全部由主进程计算，渲染层只负责展示与复制。
 */
import { chmod, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { McpSetupInfo } from "../../shared/ipc";

export type { McpSetupInfo };

/**
 * CLI 文件名就是 `sqraft-mcp`（没有扩展名）：装进 PATH 后 agent 配置里直接写这个命令，
 * 和软链名、`claude mcp add` 里的命令名三者一致，不会被误写成 `sqraft-mcp.js`。
 * 文件自带 shebang，未安装时用 `node <绝对路径>` 也能跑。
 */
export function cliScriptPath(options: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return options.packaged
    ? join(options.resourcesPath, "bin", "sqraft-mcp")
    : resolve(options.appPath, "resources/bin/sqraft-mcp");
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

/** 目标目录里 `sqraft-mcp` 的现状。 */
export type EntryState =
  | "absent" // 没装
  | "current" // 已指向当前 CLI
  | "stale" // 指向本应用 bin 目录里的旧文件（改名前的 sqraft-mcp.js）
  | "foreign"; // 指向别处，或是普通文件/目录

/**
 * 判定 `entry` 指向谁。`stale` 是 CLI 改名留下的历史链接：
 * 升级后它指向的 `sqraft-mcp.js` 已经不存在，必须能识别并替换，否则老用户的
 * agent 会断链，而 UI 又因为"不是本应用创建"拒绝修复。
 */
export async function inspectEntry(entry: string, cliPath: string): Promise<EntryState> {
  const existing = await lstat(entry).catch(() => null);
  if (!existing) return "absent";
  if (!existing.isSymbolicLink()) return "foreign";

  let target: string;
  try {
    target = resolve(dirname(entry), await readlink(entry));
  } catch {
    return "foreign";
  }

  const current = resolve(cliPath);
  if (target === current) return "current";

  const sameBin = dirname(target) === dirname(current);
  const legacyName = /^sqraft-mcp(\.js)?$/.test(basename(target));
  return sameBin && legacyName ? "stale" : "foreign";
}

/**
 * 在目标目录建立 `sqraft-mcp` 软链。
 * 已指向同一脚本时视为成功；指向本应用旧文件名的链接会被替换；其余一律拒绝覆盖。
 */
export async function installCli(cliPath: string, dir: string): Promise<InstallResult> {
  const entry = join(dir, "sqraft-mcp");
  try {
    await mkdir(dir, { recursive: true });
    await chmod(cliPath, 0o755).catch(() => {});
    const state = await inspectEntry(entry, cliPath);

    if (state === "current") return { ok: true, path: entry, message: `已经安装：${entry}` };
    if (state === "foreign") {
      return { ok: false, message: `${entry} 已存在且不是本应用创建的（或指向别的文件），未覆盖。可以手动删除后重试。` };
    }

    // stale：改名前的链接，先摘掉再建新的
    if (state === "stale") await unlink(entry);
    await symlink(cliPath, entry);
    return {
      ok: true,
      path: entry,
      message: state === "stale" ? `已更新：${entry} → ${cliPath}` : `已安装到 ${entry}`,
    };
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
  /** 覆盖安装目录（测试用；默认按平台算） */
  targetDir?: string;
}): Promise<McpSetupInfo> {
  const cliPath = cliScriptPath(options);
  const targetDir = options.targetDir ?? installTargetDir(options.platform);
  const entry = join(targetDir, "sqraft-mcp");

  const installed = (await inspectEntry(entry, cliPath)) === "current";

  // 未安装时直接用 node 跑脚本，不依赖文件的可执行位
  const command = installed ? "sqraft-mcp" : `node ${cliPath}`;
  return {
    cliPath,
    installed,
    installedPath: installed ? entry : null,
    targetDir,
    commandLine: `claude mcp add sqraft -- ${command}`,
    // OpenCode V2：本地 server 的命令写在 `--` 之后，`--global` 写进全局配置
    opencodeCommand: `opencode mcp add sqraft --global -- ${command}`,
    json: JSON.stringify(
      { mcpServers: { sqraft: { command: "node", args: [cliPath] } } },
      null,
      2,
    ),
    // OpenCode V2 的形状：服务器在 mcp.servers 下，type 必须为 local
    opencodeJson: JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: { servers: { sqraft: { type: "local", command: ["node", cliPath] } } },
      },
      null,
      2,
    ),
  };
}
