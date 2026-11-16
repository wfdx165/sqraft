/**
 * 四个文件 adapter 的固定表：路径、entry 键、写入形状、检测依据。
 *
 * 路径与形状的真源是 `docs/specs/mcp-client-config.md` 的客户端矩阵；
 * 改这里必须同步 spec 与测试。
 */
import { join } from "node:path";
import type { ClientAdapter, ClientContext } from "./types";
import { createFileAdapter, selectByEntry, type FileAdapterSpec } from "./file-adapter";
import { resolveExecutable } from "./detect";

const CURSOR_ENTRY = ["mcpServers", "sqraft"] as const;
const VSCODE_ENTRY = ["mcpServers", "sqraft"] as const;
const ZED_ENTRY = ["context_servers", "sqraft"] as const;
const OPENCODE_ENTRY = ["mcp", "servers", "sqraft"] as const;

function copilotHome(ctx: ClientContext): string {
  const configured = ctx.env.COPILOT_HOME;
  return configured && configured.trim() ? configured : join(ctx.home, ".copilot");
}

/** VS Code 的旧编辑器配置目录：只用于「装了 VS Code」的检测，不写。 */
function vscodeDataDir(ctx: ClientContext): string {
  if (ctx.platform === "win32") return join(ctx.env.APPDATA ?? join(ctx.home, "AppData", "Roaming"), "Code");
  if (ctx.platform === "darwin") return join(ctx.home, "Library", "Application Support", "Code");
  return join(ctx.home, ".config", "Code");
}

function cursorSpec(ctx: ClientContext): FileAdapterSpec {
  const app =
    ctx.platform === "darwin"
      ? ["/Applications/Cursor.app"]
      : ctx.platform === "win32"
        ? [join(ctx.env.LOCALAPPDATA ?? join(ctx.home, "AppData", "Local"), "Programs", "cursor")]
        : [];
  return {
    id: "cursor",
    configPaths: () => [join(ctx.home, ".cursor", "mcp.json")],
    entryPath: CURSOR_ENTRY,
    valueFor: (url) => ({ url }),
    appPaths: () => app,
  };
}

function vscodeSpec(ctx: ClientContext): FileAdapterSpec {
  const app =
    ctx.platform === "darwin"
      ? ["/Applications/Visual Studio Code.app", vscodeDataDir(ctx)]
      : ctx.platform === "win32"
        ? [join(ctx.env.LOCALAPPDATA ?? join(ctx.home, "AppData", "Local"), "Programs", "Microsoft VS Code"), vscodeDataDir(ctx)]
        : [vscodeDataDir(ctx)];
  return {
    id: "vscode",
    configPaths: () => [join(copilotHome(ctx), "mcp-config.json")],
    entryPath: VSCODE_ENTRY,
    valueFor: (url) => ({ type: "http", url }),
    appPaths: () => app,
  };
}

function zedSpec(ctx: ClientContext): FileAdapterSpec {
  const app =
    ctx.platform === "darwin"
      ? ["/Applications/Zed.app"]
      : ctx.platform === "win32"
        ? [join(ctx.env.APPDATA ?? join(ctx.home, "AppData", "Roaming"), "Zed")]
        : [];
  const path =
    ctx.platform === "win32"
      ? join(ctx.env.APPDATA ?? join(ctx.home, "AppData", "Roaming"), "Zed", "settings.json")
      : join(ctx.home, ".config", "zed", "settings.json");
  return {
    id: "zed",
    configPaths: () => [path],
    entryPath: ZED_ENTRY,
    valueFor: (url) => ({ url }),
    appPaths: () => app,
  };
}

function opencodeSpec(ctx: ClientContext): FileAdapterSpec {
  const dir = join(ctx.home, ".config", "opencode");
  return {
    id: "opencode",
    configPaths: () => [join(dir, "opencode.json"), join(dir, "opencode.jsonc")],
    entryPath: OPENCODE_ENTRY,
    valueFor: (url) => ({ type: "remote", url }),
    extraDetect: async () => (await resolveExecutable(["opencode"], ctx)) !== null,
    select: selectByEntry(OPENCODE_ENTRY, "opencode.json"),
  };
}

export function createFileAdapters(ctx: ClientContext): ClientAdapter[] {
  return [
    createFileAdapter(cursorSpec(ctx), ctx),
    createFileAdapter(vscodeSpec(ctx), ctx),
    createFileAdapter(zedSpec(ctx), ctx),
    createFileAdapter(opencodeSpec(ctx), ctx),
  ];
}
