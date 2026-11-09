/**
 * 渲染层的 MCP 工具宿主：清单与执行器都来自 @sqraft/ai-tools（唯一真源）。
 * 没有打开文档时，第一次工具调用会先建一份空稿——agent 不该卡在欢迎页。
 */
import { reactive } from "vue";
import { MUTATING_TOOLS, makeExecutor, toMCPManifest } from "@sqraft/ai-tools";
import type { NodeId } from "@sqraft/core";
import type { McpClientInfo, McpStatus } from "../shared/ipc";
import {
  beginAgentActivity,
  endAgentActivity,
  isCrossPage,
  markRects,
  outermostNodes,
  pageOf,
  rectInViewport,
  resetAgentActivity,
  setAgentTargets,
} from "./canvas/agent-activity";
import { docStore, hooks, ui } from "./store";
import { newDocument, openDocument } from "./file-session";
import { appInfo } from "./app-meta";
import { textSizeOf } from "./text-metrics";
import { putAsset } from "./assets";
import { putFont } from "./fonts";
import { t } from "./i18n";
import { agentErrorText } from "./errors";
import { AGENT_TEXT } from "../shared/agent-text";

/** 一次写工具调用在界面上留下的痕迹（纯 UI；结束 5 秒后清空） */
export interface McpActivity {
  /** 客户端身份，已去掉 `cN ` 前缀；拿不到时是 `agent` */
  label: string;
  /** 工具名 */
  tool: string;
  /** 改动落在哪一页；没有改动时为 null */
  pageId: NodeId | null;
  pageName: string | null;
  /** 改动不在当前视口里（跨页或同页视口外） */
  offscreen: boolean;
  /** 调用是否还在执行 */
  running: boolean;
}

/** 连接状态（纯 UI，不进文档）：欢迎页的状态行与文档态的胶囊共用它 */
export const mcpUi = reactive({
  listening: false,
  /** 活跃会话列表（只读展示）；计数一律取 length */
  clients: [] as McpClientInfo[],
  busy: false,
  /** 进行中/刚结束的一次写操作；胶囊据此显示"谁在改哪里" */
  activity: null as McpActivity | null,
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

/** 写工具结束后，胶囊保留多久再回落到「已连接 N 个 agent」 */
export const ACTIVITY_RESIDUE_MS = 5000;

/** 当前调用窗口内累积的改动节点；只在写工具调用期间非空 */
let collecting: Set<NodeId> | null = null;
/** `delete_node` 删掉的那个节点的父容器：删完就查不到归属了，只能在调用前记下来 */
let deleteParent: NodeId | null = null;
let activityTimer: ReturnType<typeof setTimeout> | null = null;

/** `c1 claude-code/2.1` → `claude-code/2.1`：胶囊里只留身份，不留会话序号 */
export function displayClientLabel(label: string | undefined): string {
  if (!label) return "agent";
  const trimmed = label.replace(/^c\d+\s+/, "").trim();
  return trimmed || "agent";
}

/** 视口对应的世界矩形（文档坐标）；画布还没挂载时为 null。 */
function viewportWorldRect(): { x: number; y: number; width: number; height: number } | null {
  const vp = hooks.getViewport();
  if (!vp || vp.zoom <= 0) return null;
  return { x: vp.x, y: vp.y, width: vp.width / vp.zoom, height: vp.height / vp.zoom };
}

/**
 * 用当前累积的改动刷新描边与胶囊文案。
 * 调用期间每次文档变更都会走一次，所以描边是"边改边长出来"的，而不是结束后才出现。
 */
function publishAgentTargets(tool: string, label: string, running: boolean): void {
  const doc = docStore.doc;
  const ids = new Set<NodeId>(collecting ?? []);
  // 删除的节点已经不在文档里，改用删除前的父容器；父容器是页面时跳过（整页虚线没有信息量）
  if (deleteParent && doc.nodes[deleteParent]?.type !== "page") ids.add(deleteParent);

  const outermost = outermostNodes(ids, doc.nodes);
  const rects = markRects(outermost, doc);
  // 一次调用碰了多页时只取第一处（撤销记录也只有一条，胶囊不逐个报）
  const pageId = outermost.length > 0 ? pageOf(doc.nodes, outermost[0]) : null;
  setAgentTargets(rects, pageId);

  const view = viewportWorldRect();
  const crossPage = isCrossPage(pageId, ui.activePageId, ui.mode === "edit");
  // 跨页一定"看不见"；同页则看改动矩形有没有落在视口里（create_page 之类没有矩形时按看得见处理）
  const anyVisible = view && rects.length > 0 ? rects.some((rect) => rectInViewport(rect, view)) : true;
  mcpUi.activity = {
    label,
    tool,
    pageId,
    pageName: pageId ? (doc.nodes[pageId]?.name ?? null) : null,
    offscreen: crossPage || !anyVisible,
    running,
  };
}

function clearActivityTimer(): void {
  if (activityTimer === null) return;
  clearTimeout(activityTimer);
  activityTimer = null;
}

function beginAgentCall(tool: string, clientLabel: string | undefined, args: Record<string, unknown>): void {
  clearActivityTimer();
  collecting = new Set<NodeId>();
  deleteParent = null;
  const nodeId = args.nodeId;
  if (tool === "delete_node" && typeof nodeId === "string") {
    deleteParent = docStore.doc.nodes[nodeId]?.parentId ?? null;
  }
  beginAgentActivity();
  publishAgentTargets(tool, displayClientLabel(clientLabel), true);
  hooks.requestRedraw();
}

function finishAgentCall(ok: boolean): void {
  // 失败的调用已经回滚：不描边、不留"刚改了…"的假信息
  if (!ok) {
    collecting = null;
    deleteParent = null;
    clearActivityTimer();
    mcpUi.activity = null;
    resetAgentActivity();
    hooks.requestRedraw();
    return;
  }
  const activity = mcpUi.activity;
  // 先按最终改动刷一次（此刻 collecting 还在），再清窗口
  if (activity) publishAgentTargets(activity.tool, activity.label, false);
  collecting = null;
  deleteParent = null;
  endAgentActivity();
  hooks.requestRedraw();
  clearActivityTimer();
  activityTimer = setTimeout(() => {
    activityTimer = null;
    mcpUi.activity = null;
    resetAgentActivity();
    hooks.requestRedraw();
  }, ACTIVITY_RESIDUE_MS);
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
  // 写工具调用窗口内累积改动节点：事务内每次 apply 都带真实的 changed（提交时那次是空集合）
  const offDoc = docStore.subscribe((_state, changed) => {
    if (!collecting) return;
    for (const id of changed) collecting.add(id);
    const activity = mcpUi.activity;
    if (activity?.running) publishAgentTargets(activity.tool, activity.label, true);
  });
  // 服务可能比页面先就绪，也可能稍后才监听成功：挂载时主动取一次
  refreshMcpStatus();

  const executor = makeExecutor(
    docStore,
    (region) => hooks.getScreenshot(region),
    () => ui.activePageId,
    (node, style, text) => textSizeOf(node, style, text, docStore.doc),
    {
      newDocument: () => newDocument(),
      openDocument: () => openDocument(),
      appInfo: async () => {
        const info = await appInfo();
        return { name: info.name, version: info.version, platform: window.sqraft.platform };
      },
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
    // agent 建的页面/组件默认名也跟随界面语言
    (kind) => t(kind === "page" ? "node.page" : "node.component"),
  );

  const offCall = bridge.mcp.onCall(async ({ id, name, args, clientLabel }) => {
    // 同一条调用被投递两次（旧实例漏摘的监听、主进程重复 send）：静默丢弃，
    // 主进程按第一次的 respond 收口。调用号全局唯一，不会误伤别的调用。
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      // 一次只允许一个调用在飞：DocStore 只有一个事务槽，重入会把两个调用并成一条撤销记录
      if (mcpUi.busy) {
        bridge.mcp.respond({ id, ok: false, error: AGENT_TEXT.busy });
        return;
      }
      mcpUi.busy = true;
      // 只有会改文档的工具才在画布上留痕迹：只读工具没有视觉落点
      const mutates = MUTATING_TOOLS.has(name);
      let ok = false;
      try {
        if (!ui.docOpen) await newDocument();
        if (mutates) beginAgentCall(name, clientLabel, args);
        const value = await executor(name, args);
        ok = true;
        bridge.mcp.respond({ id, ok: true, value });
      } catch (error) {
        bridge.mcp.respond({ id, ok: false, error: agentErrorText(error) });
      } finally {
        mcpUi.busy = false;
        if (mutates) finishAgentCall(ok);
      }
    } finally {
      inFlight.delete(id);
    }
  });

  const handle: McpHostHandle = {
    off: () => {
      offCall();
      offStatus();
      offDoc();
      collecting = null;
      deleteParent = null;
      clearActivityTimer();
      resetAgentActivity();
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
