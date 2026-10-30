/**
 * MCP 主进程侧：把协议层（server.ts）与渲染层桥接起来。
 * 工具清单与执行器都在渲染层（@sqraft/ai-tools 的真源），这里只转发。
 */
import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CHANNELS,
  type McpCallResult,
  type McpStatus,
  type McpToolInfo,
} from "../../shared/ipc";
import { startMcpServer, type McpRuntime } from "./server";
import { collectSetupInfo, installCli, writableInstallDir } from "./setup";

let runtime: McpRuntime | null = null;
let tools: McpToolInfo[] = [];
let sequence = 0;

/** 与渲染层 `MAX_ASSET_BYTES` 对齐的读盘上限（主进程拿不到渲染层常量）。 */
const MAX_CLIPBOARD_BYTES = 20 * 1024 * 1024;

interface PendingCall {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingCall>();

/** 比队列的 30s 稍长：队列负责给客户端回超时，这里只负责清理挂起表。 */
const PENDING_TTL_MS = 35_000;

async function setupInfo() {
  return collectSetupInfo({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
}

/** 服务状态：`listening` 由运行时是否存在推导，渲染层据此显示"监听中 / 未启动"。 */
function currentStatus(): McpStatus {
  return { listening: runtime !== null, clients: runtime?.clientCount() ?? 0 };
}

function broadcastStatus(): void {
  const status = currentStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(CHANNELS.mcpStatus, status);
  }
}

export function registerMcpChannels(): void {
  ipcMain.handle(CHANNELS.mcpSetup, () => setupInfo());
  ipcMain.handle(CHANNELS.mcpStatusQuery, () => currentStatus());

  ipcMain.handle(CHANNELS.mcpInstallCli, async () => {
    const { dir } = await writableInstallDir();
    const info = await setupInfo();
    const result = await installCli(info.cliPath, dir);
    return { ok: result.ok, message: result.message, info: await setupInfo() };
  });

  ipcMain.on(CHANNELS.appCopyText, (_event, text: string) => {
    clipboard.writeText(String(text));
  });

  ipcMain.handle(CHANNELS.appClipboardText, () => clipboard.readText());

  ipcMain.handle(CHANNELS.appClipboardImage, async () => {
    // Electron 45 的剪贴板是 W3C 风格：has/read/getType，不再有 readImage。
    // 真实格式交给渲染层的 magic bytes 判定，这里只负责挑一种能读的表示：
    // 常见格式优先，实在只有 TIFF 之类也照传，让上层报"不支持的格式"而不是静默。
    const preferred = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    let fallback: Uint8Array | null = null;
    for (const item of await clipboard.read()) {
      const exact = preferred.find((mime) => item.types.includes(mime));
      const type = exact ?? item.types.find((mime) => mime.startsWith("image/"));
      if (!type) continue;
      const blob = (await item.getType(type)) as Blob;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length === 0) continue;
      if (exact) return bytes;
      fallback ??= bytes;
    }
    if (fallback) return fallback;
    // Finder 里复制的是"文件"而不是位图：剪贴板只有文件 URL，按路径读一次
    return clipboardFileImage();
  });

  ipcMain.on(CHANNELS.mcpSetTools, (_event, next: McpToolInfo[]) => {
    tools = Array.isArray(next) ? next : [];
  });

  ipcMain.on(CHANNELS.mcpRespond, (_event, result: McpCallResult) => {
    const entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id);
    clearTimeout(entry.timer);
    if (result.ok && typeof result.value === "string") entry.resolve(result.value);
    else entry.reject(new Error(result.error ?? "工具执行失败"));
  });
}

export async function startMcp(endpoint: string, appVersion: string): Promise<void> {
  runtime = await startMcpServer({
    endpoint,
    appVersion,
    onClientChange: () => broadcastStatus(),
    host: {
      list: () => tools,
      call: (name, args) => callRenderer(name, args),
    },
  });
  // 服务可能在页面挂载之后才就绪：主动推一次，欢迎页不必轮询
  broadcastStatus();
}

function callRenderer(name: string, args: Record<string, unknown>): Promise<string> {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return Promise.reject(new Error("Sqraft 窗口未打开，无法执行工具"));
  const id = sequence + 1;
  sequence = id;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("渲染层没有在预期时间内返回结果"));
    }, PENDING_TTL_MS);
    pending.set(id, { resolve, reject, timer });
    window.webContents.send(CHANNELS.mcpCall, { id, name, args });
  });
}

/**
 * 从 Finder 复制图片文件时，剪贴板里只有文件 URL（furl），没有位图字节。
 * 这是用户主动复制的路径，读一次文件是预期行为；不是给 agent 开的读盘口子。
 * 先 stat 再读：复制一个几百 MB 的文件不该先把内存吃掉再报错。
 */
async function clipboardFileImage(): Promise<Uint8Array | null> {
  for (const item of await clipboard.read()) {
    const type = item.types.find((t) => t === "text/uri-list" || t.includes("file-url"));
    if (!type) continue;
    let text: string;
    try {
      const value = await item.getType(type);
      text = typeof value === "string" ? value : await (value as Blob).text();
    } catch {
      continue;
    }
    const line = text.split(/\r?\n/).find((entry) => entry && !entry.startsWith("#"));
    if (!line) continue;
    let path: string;
    try {
      path = fileURLToPath(line.trim());
    } catch {
      continue;
    }
    if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(path)) continue;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size === 0 || info.size > MAX_CLIPBOARD_BYTES) continue;
      const bytes = new Uint8Array(await readFile(path));
      if (bytes.length === 0 || bytes.length > MAX_CLIPBOARD_BYTES) continue;
      return bytes;
    } catch {
      continue;
    }
  }
  return null;
}

/** 退出前告知所有客户端，避免它们收到"连接被重置"。 */
export function shutdownMcp(): void {
  runtime?.broadcastShutdown();
}

export function mcpClientCount(): number {
  return runtime?.clientCount() ?? 0;
}
