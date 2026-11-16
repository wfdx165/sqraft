/**
 * 检测：找客户端可执行文件、找固定路径。不跑登录 shell、不调 `which`。
 *
 * GUI 进程的 PATH 通常只有系统目录，所以先查常见安装目录，再拼 PATH；
 * nvm 的版本目录要 glob 展开（`~/.nvm/versions/node/<version>/bin`）。
 */
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { pathExists } from "./fs";

export interface DetectContext {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/** `~` 展开；其它路径原样返回（不解析环境变量，避免不可控输入）。 */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** 固定候选目录（按优先级）；nvm 需要 readdir，放在 `binSearchDirs` 里展开。 */
export function fixedBinDirs(ctx: DetectContext): string[] {
  const home = ctx.home;
  const common = [join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, "Library", "pnpm")];
  if (ctx.platform === "win32") {
    const appData = ctx.env.APPDATA ?? join(home, "AppData", "Roaming");
    const localAppData = ctx.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [join(appData, "npm"), join(localAppData, "pnpm")];
  }
  if (ctx.platform === "darwin") return ["/opt/homebrew/bin", "/usr/local/bin", ...common];
  return ["/usr/local/bin", ...common];
}

/** 候选目录 + nvm 展开 + PATH 目录（去重、保持顺序）。 */
export async function binSearchDirs(ctx: DetectContext): Promise<string[]> {
  const dirs = fixedBinDirs(ctx);
  const nvmRoot = join(ctx.home, ".nvm", "versions", "node");
  try {
    const versions = await readdir(nvmRoot);
    for (const version of versions.sort().reverse()) dirs.push(join(nvmRoot, version, "bin"));
  } catch {
    /* 没装 nvm 是最常见的情况 */
  }
  for (const entry of (ctx.env.PATH ?? "").split(delimiter)) {
    if (entry) dirs.push(entry);
  }
  return [...new Set(dirs)];
}

export interface ResolvedExecutable {
  path: string;
  /** Windows 的 `.cmd` / `.bat` 需要 cmd.exe 包装 */
  batch: boolean;
}

/**
 * 在候选目录里找第一个可执行文件。
 * Windows 依次尝试原名的 `.exe` / `.cmd` / `.bat`；POSIX 检查 X_OK。
 */
export async function resolveExecutable(
  names: readonly string[],
  ctx: DetectContext,
): Promise<ResolvedExecutable | null> {
  const dirs = await binSearchDirs(ctx);
  for (const dir of dirs) {
    for (const name of names) {
      const candidates =
        ctx.platform === "win32"
          ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
          : [name];
      for (const candidate of candidates) {
        const path = join(dir, candidate);
        if (await isExecutable(path, ctx.platform)) {
          return { path, batch: ctx.platform === "win32" && !candidate.endsWith(".exe") };
        }
      }
    }
  }
  return null;
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 任一路径存在（App 本体、配置文件的检测都用它）。 */
export async function anyPathExists(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    if (await pathExists(path)) return true;
  }
  return false;
}
