/**
 * MCP 主进程侧：把协议层（server.ts）与渲染层桥接起来。
 * 工具清单与执行器都在渲染层（@sqraft/ai-tools 的真源），这里只转发。
 */
import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import { CHANNELS, type McpCallResult, type McpToolInfo } from "../../shared/ipc";
import { startMcpServer, type McpRuntime } from "./server";
import { collectSetupInfo, installCli, writableInstallDir } from "./setup";

let runtime: McpRuntime | null = null;
let tools: McpToolInfo[] = [];
let sequence = 0;

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

export function registerMcpChannels(): void {
  ipcMain.handle(CHANNELS.mcpSetup, () => setupInfo());

  ipcMain.handle(CHANNELS.mcpInstallCli, async () => {
    const { dir } = await writableInstallDir();
    const info = await setupInfo();
    const result = await installCli(info.cliPath, dir);
    return { ok: result.ok, message: result.message, info: await setupInfo() };
  });

  ipcMain.on(CHANNELS.appCopyText, (_event, text: string) => {
    clipboard.writeText(String(text));
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
    onClientChange: (clients) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(CHANNELS.mcpStatus, { clients });
      }
    },
    host: {
      list: () => tools,
      call: (name, args) => callRenderer(name, args),
    },
  });
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

/** 退出前告知所有客户端，避免它们收到"连接被重置"。 */
export function shutdownMcp(): void {
  runtime?.broadcastShutdown();
}

export function mcpClientCount(): number {
  return runtime?.clientCount() ?? 0;
}
