/**
 * MCP 主进程侧：把协议层（server.ts）与渲染层桥接起来。
 * 工具清单与执行器都在渲染层（@sqraft/ai-tools 的真源），这里只转发。
 */
import { app, BrowserWindow, ClipboardItem, clipboard, ipcMain } from "electron";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANNELS,
  type McpCallResult,
  type McpSetupInfo,
  type McpStatus,
  type McpToolInfo,
} from "../../shared/ipc";
import { currentPreferences, updateMcpPreferences } from "../recent-state";
import { logError, logInfo, logWarn } from "./log";
import { isValidPort, MCP_DEFAULT_PORT, MCP_FALLBACK_STEPS } from "./port";
import { startMcpServer, type McpRuntime } from "./server";
import { collectSetupInfo } from "./setup";

let runtime: McpRuntime | null = null;
/** 启动失败原因（端口被占等）；成功时为 null */
let startError: string | null = null;
/** 自动模式下发生漂移时原来想用的端口 */
let driftFrom: number | null = null;
let appVersion = "0.0.0";
let tools: McpToolInfo[] = [];
let sequence = 0;

/** 与渲染层 `MAX_ASSET_BYTES` 对齐的读盘上限（主进程拿不到渲染层常量）。 */
const MAX_CLIPBOARD_BYTES = 20 * 1024 * 1024;

/**
 * 节点剪贴板的自定义类型。
 *
 * 不能用 W3C 风格的 `application/x-sqraft+nodes`：macOS 会把它变成
 * `dyn.ah62d4rv4…` 这类动态 UTI，`clipboard.has()` 直接返回 false、`read()` 也拿不到内容
 * （Electron 45 实测）。Electron 文档留的口子是平台原始类型，即
 * `electron application/osclipboard;format="<UTI>"`；反向域名形式的 UTI 能正常往返。
 */
const NODES_UTI = "com.sqraft.nodes";
const NODES_FORMAT = `electron application/osclipboard;format="${NODES_UTI}"`;

interface PendingCall {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingCall>();

/** 比队列的 30s 稍长：队列负责给客户端回超时，这里只负责清理挂起表。 */
const PENDING_TTL_MS = 35_000;

/** 首选端口：显式偏好优先，其次自动模式上次成功的端口。 */
function preferredPort(): { port: number; explicit: boolean } {
  const prefs = currentPreferences().mcp ?? {};
  if (prefs.port !== undefined) return { port: prefs.port, explicit: true };
  return { port: prefs.autoPort ?? MCP_DEFAULT_PORT, explicit: false };
}

function setupInfo(): McpSetupInfo {
  const { port, explicit } = preferredPort();
  const shownPort = runtime?.port ?? port;
  return collectSetupInfo({
    url: `http://127.0.0.1:${shownPort}/mcp`,
    listening: runtime !== null,
    port: runtime?.port ?? null,
    explicitPort: explicit ? port : null,
    driftFrom: runtime === null ? null : driftFrom,
    error: startError,
  });
}

/** 服务状态：`listening` 由运行时是否存在推导，渲染层据此显示"监听中 / 未启动"。 */
function currentStatus(): McpStatus {
  return {
    listening: runtime !== null,
    port: runtime?.port ?? null,
    url: runtime?.url ?? null,
    clients: runtime?.clients() ?? [],
    error: startError,
    driftFrom,
  };
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
  ipcMain.handle(CHANNELS.mcpSetPort, (_event, port: unknown) => setMcpPort(port));

  ipcMain.on(CHANNELS.appCopyText, (_event, text: string) => {
    clipboard.writeText(String(text));
  });

  ipcMain.handle(CHANNELS.appClipboardText, () => clipboard.readText());

  ipcMain.handle(CHANNELS.appClipboardImageWrite, async (_event, dataUrl: string) => {
    const match = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl));
    if (!match) return false;
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.length === 0) return false;
    const blob = new Blob([bytes], { type: "image/png" });
    await clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  });

  ipcMain.handle(CHANNELS.appClipboardNodesWrite, async (_event, json: string) => {
    const text = String(json);
    if (text.length === 0) {
      logWarn("clipboard", "write nodes: 空载荷，已忽略");
      return;
    }
    // 一次 write 原子提交：载荷是 JSON 字符串，图片已经内联成 base64
    try {
      const blob = new Blob([text], { type: "application/octet-stream" });
      await clipboard.write([new ClipboardItem({ [NODES_FORMAT]: blob })]);
      logInfo("clipboard", "write nodes ok", { bytes: text.length });
    } catch (error) {
      logError("clipboard", "write nodes failed", { error: String(error) });
      throw error;
    }
  });

  ipcMain.handle(CHANNELS.appClipboardNodesRead, async () => {
    // 不用 has() 提前返回：它对自定义类型不可靠，直接遍历 types 匹配更实在
    try {
      for (const item of await clipboard.read()) {
        if (!item.types.includes(NODES_FORMAT)) continue;
        const value = await item.getType(NODES_FORMAT);
        const text = typeof value === "string" ? value : await (value as Blob).text();
        if (!text) {
          logWarn("clipboard", "read nodes: 类型存在但内容为空");
          return null;
        }
        return text;
      }
    } catch (error) {
      logError("clipboard", "read nodes failed", { error: String(error) });
      return null;
    }
    return null;
  });

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

/** 写一份只读的运行信息供排障（`~/.sqraft/mcp.json`）；客户端发现机制不用它。 */
async function writeRuntimeInfo(): Promise<void> {
  const file = join(app.getPath("userData"), "mcp.json");
  const payload = {
    port: runtime?.port ?? null,
    url: runtime?.url ?? null,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    error: startError,
  };
  await writeFile(file, JSON.stringify(payload, null, 2), { mode: 0o600 }).catch(() => {});
  // 写已存在的文件时 mode 不生效，权限单独收敛一次
  await chmod(file, 0o600).catch(() => {});
}

/**
 * 启动（或重启）HTTP 服务。端口规则：
 * - 显式端口（偏好里手填的）严格执行，被占就失败、不顺延；
 * - 自动模式从 7331 / 上次成功的端口起，被占向上顺延，并把实际端口写回偏好。
 */
async function startServer(): Promise<void> {
  const { port, explicit } = preferredPort();
  const previousAuto = currentPreferences().mcp?.autoPort;

  let next: McpRuntime;
  try {
    next = await startMcpServer({
      bindHost: "127.0.0.1",
      port,
      fallbackSteps: explicit ? 0 : MCP_FALLBACK_STEPS,
      appVersion,
      onClientChange: () => broadcastStatus(),
      host: {
        list: () => tools,
        call: (name, args, origin) => callRenderer(name, args, origin?.clientLabel),
      },
    });
  } catch (error) {
    runtime = null;
    driftFrom = null;
    startError = error instanceof Error ? error.message : String(error);
    logError(null, "server start failed", { port, error: startError });
    await writeRuntimeInfo();
    broadcastStatus();
    return;
  }

  runtime = next;
  startError = null;
  driftFrom = !explicit && next.port !== port ? port : null;

  // 持久化失败不该推翻已经跑起来的服务：只记一条 warn，端口下次再收敛
  if (!explicit && next.port !== previousAuto) {
    try {
      await updateMcpPreferences({ autoPort: next.port });
    } catch (error) {
      logWarn(null, "persist mcp port failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (driftFrom !== null) {
    logWarn(null, "port drifted", { from: driftFrom, to: next.port, clients: 0 });
  }
  await writeRuntimeInfo();
  // 服务可能在页面挂载之后才就绪：主动推一次，欢迎页不必轮询
  broadcastStatus();
}

export async function startMcp(version: string): Promise<void> {
  appVersion = version;
  await startServer();
}

/** 改端口：null = 自动模式；数字 = 严格使用。会重启服务并断开所有现有会话。 */
export async function setMcpPort(port: unknown): Promise<McpSetupInfo> {
  if (port !== null && !isValidPort(port)) {
    throw new Error("端口必须是 1024–65535 的整数");
  }
  const previousPort = runtime?.port ?? null;
  if (runtime) {
    await runtime.close();
    runtime = null;
    broadcastStatus();
  }
  if (port === null) {
    // 回到自动模式：优先沿用刚才的端口，避免无谓漂移
    await updateMcpPreferences({ port: null, autoPort: previousPort });
  } else {
    await updateMcpPreferences({ port, autoPort: null });
  }
  logInfo(null, "port preference changed", { port: port ?? "auto", previous: previousPort });
  await startServer();
  return setupInfo();
}

function callRenderer(
  name: string,
  args: Record<string, unknown>,
  clientLabel?: string,
): Promise<string> {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    logError(null, "call failed: no window", { tool: name });
    return Promise.reject(new Error("Sqraft 窗口未打开，无法执行工具"));
  }
  const id = sequence + 1;
  sequence = id;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      logError(null, "renderer timeout", { tool: name, after: `${PENDING_TTL_MS}ms` });
      reject(new Error("渲染层没有在预期时间内返回结果"));
    }, PENDING_TTL_MS);
    pending.set(id, { resolve, reject, timer });
    window.webContents.send(CHANNELS.mcpCall, { id, name, args, clientLabel });
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

/** 退出前关掉监听；HTTP 没有长连接广播，客户端下次请求会发现连不上。 */
export function shutdownMcp(): void {
  void runtime?.close().catch((error: unknown) => {
    logError(null, "server close failed", { error: error instanceof Error ? error.message : String(error) });
  });
  runtime = null;
}
