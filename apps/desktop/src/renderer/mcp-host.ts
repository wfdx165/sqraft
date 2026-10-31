/**
 * 渲染层的 MCP 工具宿主：清单与执行器都来自 @sqraft/ai-tools（唯一真源）。
 * 没有打开文档时，第一次工具调用会先建一份空稿——agent 不该卡在欢迎页。
 */
import { reactive } from "vue";
import { makeExecutor, toMCPManifest } from "@sqraft/ai-tools";
import type { McpClientInfo, McpStatus } from "../shared/ipc";
import { docStore, hooks, ui } from "./store";
import { newDocument, openDocument } from "./file-session";
import { textSizeOf } from "./text-metrics";
import { putAsset } from "./assets";
import { putFont } from "./fonts";

/** 连接状态（纯 UI，不进文档）：欢迎页的状态行与文档态的胶囊共用它 */
export const mcpUi = reactive({
  listening: false,
  /** 活跃会话列表（只读展示）；计数一律取 length */
  clients: [] as McpClientInfo[],
  busy: false,
  /** 实际监听端口；服务没起来时为 null */
  port: null as number | null,
  /** 端点地址 */
  url: null as string | null,
  /** 启动失败原因（端口被占等） */
  error: null as string | null,
  /** 自动模式下发生漂移时，原来想用的端口 */
  driftFrom: null as number | null,
});

/** 工具数从真源取，界面不写死数字 */
const manifest = toMCPManifest();
export const MCP_TOOL_COUNT = manifest.length;

function applyStatus(status: McpStatus): void {
  mcpUi.listening = status.listening;
  mcpUi.clients = status.clients;
  mcpUi.port = status.port;
  mcpUi.url = status.url;
  mcpUi.error = status.error;
  mcpUi.driftFrom = status.driftFrom;
}

/** 主动刷新连接列表：`lastTool` 只在主进程更新，不会主动推送，详情浮层打开时轮询用。 */
export function refreshMcpStatus(): void {
  void window.sqraft.mcp.status().then(applyStatus);
}

/**
 * 宿主句柄挂在 `globalThis` 上，而不是模块变量。
 *
 * dev 热更新会重新执行本模块：模块内的守卫各实例各一份，新实例看到的永远是"没装"，
 * 于是又注册一份 `onCall`，旧的那份还活着——同一条 `tools/call` 会被两个宿主各执行一遍。
 * `create_node` 因此落两个节点：两个不同的 id，返回给 agent 的那个被拿去建子节点，
 * 另一个就是没有子节点的副本。
 */
interface McpHostHandle {
  off: () => void;
}

const hostGlobal = globalThis as {
  __sqraftMcpHost?: McpHostHandle;
  __sqraftMcpInflight?: Set<number>;
};

/** 正在执行的调用号（主进程按序分配、全局唯一）：同一条调用被重复投递时只跑第一次。 */
const inFlight = (hostGlobal.__sqraftMcpInflight ??= new Set<number>());

/** 本模块实例装上的句柄：dispose 只处置自己那一份，避免误杀新实例 */
let installedHandle: McpHostHandle | null = null;

export function installMcpHost(): void {
  // 上一份宿主（HMR 新模块实例、重复挂载）的监听先摘掉，否则一条调用会被执行两遍
  hostGlobal.__sqraftMcpHost?.off();

  const bridge = window.sqraft;
  bridge.mcp.setTools(manifest);
  const offStatus = bridge.mcp.onStatus(applyStatus);
  // 服务可能比页面先就绪，也可能稍后才监听成功：挂载时主动取一次
  refreshMcpStatus();

  const executor = makeExecutor(
    docStore,
    (region) => hooks.getScreenshot(region),
    () => ui.activePageId,
    (node, style, text) => textSizeOf(node, style, text),
    {
      newDocument: () => newDocument(),
      openDocument: () => openDocument(),
      activatePage: (pageId) => hooks.activatePage(pageId),
      exportPng: (request) => hooks.renderExport(request),
      importFont: async (fileName, dataBase64) => {
        const binary = atob(dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const result = await putFont(bytes, fileName);
        if (!result.ok) return null;
        ui.version += 1;
        return { family: result.record.family, weight: result.record.weight, style: result.record.style };
      },
      addImage: async (data, mimeType) => {
        const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
        const asset = await putAsset(bytes);
        if (!asset.ok) throw new Error(asset.reason);
        // MIME 以实际内容为准（magic bytes），不信任 agent 传的值
        void mimeType;
        return { assetId: asset.id, width: asset.width, height: asset.height };
      },
    },
    // 选区是画布 UI 状态：只读给 agent 看，改还是走显式 nodeId
    () => [...ui.selection],
  );

  const offCall = bridge.mcp.onCall(async ({ id, name, args }) => {
    // 同一条调用被投递两次（旧实例漏摘的监听、主进程重复 send）：静默丢弃，
    // 主进程按第一次的 respond 收口。调用号全局唯一，不会误伤别的调用。
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      // 一次只允许一个调用在飞：DocStore 只有一个事务槽，重入会把两个调用并成一条撤销记录
      if (mcpUi.busy) {
        bridge.mcp.respond({ id, ok: false, error: "上一个工具调用仍在执行，请稍后重试" });
        return;
      }
      mcpUi.busy = true;
      try {
        if (!ui.docOpen) await newDocument();
        const value = await executor(name, args);
        bridge.mcp.respond({ id, ok: true, value });
      } catch (error) {
        bridge.mcp.respond({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
      } finally {
        mcpUi.busy = false;
      }
    } finally {
      inFlight.delete(id);
    }
  });

  const handle: McpHostHandle = {
    off: () => {
      offCall();
      offStatus();
      if (hostGlobal.__sqraftMcpHost === handle) hostGlobal.__sqraftMcpHost = undefined;
    },
  };
  installedHandle = handle;
  hostGlobal.__sqraftMcpHost = handle;
}

/**
 * dev 热更新：只摘掉本模块实例装上的监听。
 * 构建产物里 `import.meta.hot` 为 undefined。
 */
import.meta.hot?.dispose(() => installedHandle?.off());
