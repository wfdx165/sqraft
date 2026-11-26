/**
 * MCP 主进程侧：把协议层（server.ts）与渲染层桥接起来。
 * 工具清单与执行器都在渲染层（@sqraft/ai-tools 的真源），这里只转发。
 */
import { app, BrowserWindow, clipboard, ipcMain, nativeImage } from "electron";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANNELS,
  type McpCallResult,
  type McpClientsSyncEvent,
  type McpSetupInfo,
  type McpStatus,
  type McpToolInfo,
} from "../../shared/ipc";
import { currentPreferences, updateMcpPreferences } from "../recent-state";
import { logError, logInfo, logWarn } from "./log";
import { isValidPort, MCP_DEFAULT_PORT, MCP_FALLBACK_STEPS } from "./port";
import { startMcpServer, type McpRuntime } from "./server";
import { collectSetupInfo } from "./setup";
import { createClientService, type ClientService } from "./clients/service";
import { isMcpClientId, type McpClientId } from "../../shared/mcp-clients";
import { t } from "../i18n";
import { AGENT_TEXT } from "../../shared/agent-text";

let runtime: McpRuntime | null = null;
/** 启动失败原因（端口被占等）；成功时为 null */
let startError: string | null = null;
/** 自动模式下发生漂移时原来想用的端口 */
let driftFrom: number | null = null;
let appVersion = "0.0.0";
let tools: McpToolInfo[] = [];
let sequence = 0;
/** 懒建：userData / home 只有在 app ready 之后才可靠。 */
let clientService: ClientService | null = null;

/** 与渲染层 `MAX_ASSET_BYTES` 对齐的读盘上限（主进程拿不到渲染层常量）。 */
const MAX_CLIPBOARD_BYTES = 20 * 1024 * 1024;
/** 剪贴板位图转 PNG 后的上限（5K 截图约 10–20 MB）；挡住异常大图把 IPC 内存打满。 */
const MAX_CLIPBOARD_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * 节点剪贴板的自定义格式。
 *
 * Electron 37 没有 W3C 风格的 `ClipboardItem` / `clipboard.read()`，只有
 * `writeBuffer(format)` / `readBuffer(format)` / `availableFormats()`；
 * 读取侧按最后写入的格式取，不需要遍历条目。
 *
 * format 直接当平台类型用：macOS 上反向域名形式的 UTI 能正常往返，
 * 不要用 `application/x-sqraft+nodes`——它会变成 `dyn.ah62d4…` 动态类型，
 * 读写两边对不上（Electron 45 时代实测过同类问题）。
 */
const NODES_FORMAT = "com.sqraft.nodes";

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

function clientServiceInstance(): ClientService {
  if (!clientService) {
    clientService = createClientService({
      ctx: {
        home: app.getPath("home"),
        platform: process.platform,
        env: process.env,
        userDataDir: app.getPath("userData"),
      },
      url: () => setupInfo().url,
      listening: () => runtime !== null,
      sessions: () => runtime?.clients() ?? [],
    });
  }
  return clientService;
}

/** 渲染层只传 id；路径与命令在主进程按 adapter 表解析。 */
function requireClientId(value: unknown): McpClientId {
  if (!isMcpClientId(value)) throw new Error("unknown mcp client");
  return value;
}

export function registerMcpChannels(): void {
  ipcMain.handle(CHANNELS.mcpSetup, () => setupInfo());
  ipcMain.handle(CHANNELS.mcpStatusQuery, () => currentStatus());
  ipcMain.handle(CHANNELS.mcpSetPort, (_event, port: unknown) => setMcpPort(port));
  ipcMain.handle(CHANNELS.mcpClients, () => clientServiceInstance().snapshot());
  ipcMain.handle(CHANNELS.mcpClientsAttach, (_event, id: unknown) =>
    clientServiceInstance().attach(requireClientId(id)),
  );
  ipcMain.handle(CHANNELS.mcpClientsDetach, (_event, id: unknown) =>
    clientServiceInstance().detach(requireClientId(id)),
  );
  ipcMain.handle(CHANNELS.mcpClientsReplace, (_event, id: unknown) =>
    clientServiceInstance().attach(requireClientId(id), "replace"),
  );

  ipcMain.on(CHANNELS.appCopyText, (_event, text: string) => {
    clipboard.writeText(String(text));
  });

  ipcMain.handle(CHANNELS.appClipboardText, () => clipboard.readText());

  ipcMain.handle(CHANNELS.appClipboardImageWrite, (_event, dataUrl: string) => {
    const match = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl));
    if (!match) return false;
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.length === 0) return false;
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  });

  ipcMain.handle(CHANNELS.appClipboardNodesWrite, (_event, json: string) => {
    const text = String(json);
    if (text.length === 0) {
      logWarn("clipboard", "write nodes: 空载荷，已忽略");
      return;
    }
    // 一次 write 原子提交：载荷是 JSON 字符串，图片已经内联成 base64
    const payload = Buffer.from(text, "utf8");
    try {
      clipboard.writeBuffer(NODES_FORMAT, payload);
      // 自检：write 成功不代表平台认这个类型（Electron 45 时代 UTI 被改写成 dyn.ah62d4…，
      // 写入成功、读取却拿不到）。读回不一致就直接失败，让渲染层弹「复制失败」，
      // 而不是复制"成功"、粘贴时没反应。
      const back = clipboard.readBuffer(NODES_FORMAT);
      if (!back.equals(payload)) {
        logError("clipboard", "write nodes 读回不一致", {
          format: NODES_FORMAT,
          wrote: payload.length,
          read: back.length,
          formats: clipboard.availableFormats().slice(0, 8),
        });
        throw new Error(`clipboard round-trip failed: ${NODES_FORMAT}`);
      }
      logInfo("clipboard", "write nodes ok", { bytes: payload.length });
    } catch (error) {
      logError("clipboard", "write nodes failed", { error: String(error) });
      throw error;
    }
  });

  ipcMain.handle(CHANNELS.appClipboardNodesRead, () => {
    try {
      const raw = clipboard.readBuffer(NODES_FORMAT);
      if (raw.length === 0) return null;
      const text = raw.toString("utf8");
      if (!text) {
        logWarn("clipboard", "read nodes: 类型存在但内容为空");
        return null;
      }
      return text;
    } catch (error) {
      logError("clipboard", "read nodes failed", { error: String(error) });
      return null;
    }
  });

  ipcMain.handle(CHANNELS.appClipboardImage, () => {
    // Electron 37 只有 readImage()，拿不到原始编码：位图统一转 PNG，
    // 格式判定仍交给渲染层的 magic bytes。Finder 里复制的是"文件"而不是位图，
    // 剪贴板只有 file URL，退回按路径读一次（保留 GIF 等原始编码）。
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const png = image.toPNG();
      if (png.length > MAX_CLIPBOARD_IMAGE_BYTES) {
        logWarn("clipboard", "剪贴板图片过大", { bytes: png.length });
        return null;
      }
      if (png.length > 0) return new Uint8Array(png);
    }
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

/** 写一份只读的运行信息供排障（`userData/mcp.json`）；客户端发现机制不用它。 */
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
  // 端口漂移后把清单里的客户端配置跟上；失败只提示，不阻塞启动
  void syncClientConfigs();
}

/** 端口变化后的自动同步：只处理所有权清单里的条目。 */
async function syncClientConfigs(): Promise<void> {
  if (!runtime) return;
  try {
    const result = await clientServiceInstance().sync(runtime.url);
    if (result.updated > 0 || result.failed > 0) {
      const event: McpClientsSyncEvent = result;
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(CHANNELS.mcpClientsSynced, event);
      }
    }
  } catch (error) {
    logWarn(null, "client sync failed", { error: String(error) });
  }
}

export async function startMcp(version: string): Promise<void> {
  appVersion = version;
  await startServer();
}

/** 改端口：null = 自动模式；数字 = 严格使用。会重启服务并断开所有现有会话。 */
export async function setMcpPort(port: unknown): Promise<McpSetupInfo> {
  if (port !== null && !isValidPort(port)) {
    throw new Error(t("mcp.portRange"));
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
    return Promise.reject(new Error(AGENT_TEXT.noWindow));
  }
  const id = sequence + 1;
  sequence = id;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      logError(null, "renderer timeout", { tool: name, after: `${PENDING_TTL_MS}ms` });
      reject(new Error(AGENT_TEXT.rendererTimeout));
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
  let type: string | undefined;
  try {
    type = clipboard
      .availableFormats()
      .find((format) => format === "text/uri-list" || format.includes("file-url"));
  } catch {
    return null;
  }
  if (!type) return null;
  let text: string;
  try {
    text = clipboard.readBuffer(type).toString("utf8");
  } catch {
    return null;
  }
  const line = text.split(/\r?\n/).find((entry) => entry && !entry.startsWith("#"));
  if (!line) return null;
  let path: string;
  try {
    path = fileURLToPath(line.trim());
  } catch {
    return null;
  }
  if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(path)) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_CLIPBOARD_BYTES) return null;
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.length === 0 || bytes.length > MAX_CLIPBOARD_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** 退出前关掉监听；HTTP 没有长连接广播，客户端下次请求会发现连不上。 */
export function shutdownMcp(): void {
  void runtime?.close().catch((error: unknown) => {
    logError(null, "server close failed", { error: error instanceof Error ? error.message : String(error) });
  });
  runtime = null;
}
