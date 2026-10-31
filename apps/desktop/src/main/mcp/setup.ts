/**
 * MCP 接入配置：把端点翻译成各客户端的片段，并在升级时清掉旧版 CLI 的软链。
 *
 * 传输已经是本机 HTTP（ADR-0026），不再有需要安装的命令行工具：
 * 客户端配置里只放一个 URL。这里保留 `inspectEntry()` 的唯一用途是**迁移**——
 * 老版本往 PATH 里装过 `sqraft-mcp` 软链，打包后它指向的文件已经不存在。
 */
import { lstat, readlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { McpSetupInfo } from "../../shared/ipc";

/** 旧 CLI 的文件名（ADR-0020 时期）；现在只用于识别并清理残留软链。 */
export const LEGACY_CLI_NAME = "sqraft-mcp";

/** 旧版本装 CLI 的位置。 */
export function legacyCliPath(options: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return options.packaged
    ? join(options.resourcesPath, "bin", LEGACY_CLI_NAME)
    : resolve(options.appPath, "resources/bin", LEGACY_CLI_NAME);
}

const CANDIDATE_DIRS = ["/usr/local/bin", join(homedir(), ".local", "bin")];

export function installTargetDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return join(process.env.APPDATA ?? homedir(), "npm");
  return CANDIDATE_DIRS[0];
}

/** 目标目录里 `sqraft-mcp` 的现状。 */
export type EntryState =
  | "absent" // 没装
  | "current" // 指向本应用的旧 CLI 文件（升级后该文件已删，属于残留）
  | "stale" // 指向本应用 bin 目录里的旧文件名（改名前的 sqraft-mcp.js）
  | "foreign"; // 指向别处，或是普通文件/目录

/**
 * 判定 `entry` 指向谁。只有 `current` / `stale` 是本应用留下的，
 * `foreign` 一律不碰——直接 unlink 有误删用户自己文件的先例。
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
 * 一次性迁移：删掉指向本应用旧 CLI 的软链。返回被删掉的路径（日志用）。
 * 权限不足或目标不存在都静默跳过——迁移失败不应影响启动。
 */
export async function removeStaleCliLink(options: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  dirs?: string[];
  platform?: NodeJS.Platform;
}): Promise<string[]> {
  const oldPath = legacyCliPath(options);
  const platform = options.platform ?? process.platform;
  const dirs = options.dirs ?? (platform === "win32" ? [installTargetDir(platform)] : CANDIDATE_DIRS);
  const removed: string[] = [];
  for (const dir of dirs) {
    const entry = join(dir, LEGACY_CLI_NAME);
    if ((await inspectEntry(entry, oldPath)) === "foreign") continue;
    try {
      await unlink(entry);
      removed.push(entry);
    } catch {
      /* 不存在 / 没权限：跳过 */
    }
  }
  return removed;
}

/**
 * 生成接入片段。URL 就是全部凭据（本地 loopback，无 token），
 * 所以四个预设在内容上只差外壳。
 */
export function collectSetupInfo(options: {
  url: string;
  listening: boolean;
  port: number | null;
  explicitPort: number | null;
  driftFrom: number | null;
  error: string | null;
}): McpSetupInfo {
  const url = options.url;
  return {
    ...options,
    commandLine: `claude mcp add --transport http sqraft ${url}`,
    // OpenCode V2：服务器在 mcp.servers 下，远程类型是 remote
    opencodeJson: JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: { servers: { sqraft: { type: "remote", url } } },
      },
      null,
      2,
    ),
    // Cursor 与 Claude Desktop 的 mcpServers 形状一致，分开两栏只是给用户指路径
    cursorJson: JSON.stringify({ mcpServers: { sqraft: { url } } }, null, 2),
  };
}
