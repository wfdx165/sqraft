/**
 * 渲染层的 MCP 工具宿主：清单与执行器都来自 @sqraft/ai-tools（唯一真源）。
 * 没有打开文档时，第一次工具调用会先建一份空稿——agent 不该卡在欢迎页。
 */
import { reactive, watch } from "vue";
import { MUTATING_TOOLS, makeExecutor, requiresTabId, toMCPManifest, type ToolExecutor } from "@sqraft/ai-tools";
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
import { hooks, ui } from "./store";
import { MAX_DOC_TABS, activeSession, docTabs, sessionState, type TabSession } from "./sessions";
import { tabLabel } from "./tab-label";
import { noActiveDocument, tabIdRequired, tabNotActive } from "../shared/agent-text";
import type { AppState, DocumentHost } from "@sqraft/ai-tools";
import {
  buildAgentChanges,
  captureAgentPreNames,
  clearAgentReport,
  parseAgentDiagnostics,
  setAgentReport,
} from "./agent-report";
import { appInfo } from "./app-meta";
import { measureText, textSizeOf } from "./text-metrics";
import { ensureAssetDecoded, imageFor, putAsset } from "./assets";
import { ensureLinkedImage, linkedImage } from "./linked-images";
import { putFont } from "./fonts";
import { renderPngAsync, type ExportRequest } from "./canvas/export-image";
import { renderSvgAsync } from "./canvas/svg-export";
import { insertSvgFrame } from "./canvas/svg-insert";
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

/** 一次写调用的收集窗口：订阅绑在调用开始时的标签 store 上，切标签也不会串。 */
interface CallWindow {
  sessionId: string;
  tool: string;
  label: string;
  changes: Set<NodeId>;
  off: () => void;
}

/** 只在写工具调用期间非空 */
let collecting: CallWindow | null = null;
/** `delete_node` 删掉的那个节点的父容器：删完就查不到归属了，只能在调用前记下来 */
let deleteParent: NodeId | null = null;
/** 调用前记下的节点名：删除后文档里查不到，变更清单只能靠它显示名字 */
let preNames = new Map<NodeId, string>();
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
 * 只在目标标签仍是活动标签时绘制：切走的文档不该在别人身上画描边。
 */
function publishAgentTargets(session: TabSession, tool: string, label: string, running: boolean): void {
  if (sessionState.activeId !== session.id) return;
  const doc = session.store.doc;
  const ids = new Set<NodeId>(collecting?.changes ?? []);
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

function beginAgentCall(
  session: TabSession,
  tool: string,
  clientLabel: string | undefined,
  args: Record<string, unknown>,
): void {
  clearActivityTimer();
  collecting?.off();
  const changes = new Set<NodeId>();
  // 订阅钉在这个标签的 store 上：调用中途切标签，改动仍然只记到发起调用的文档
  const off = session.store.subscribe((_state, ids) => {
    for (const id of ids) changes.add(id);
    if (sessionState.activeId !== session.id) return;
    const activity = mcpUi.activity;
    if (activity?.running) publishAgentTargets(session, activity.tool, activity.label, true);
  });
  collecting = { sessionId: session.id, tool, label: displayClientLabel(clientLabel), changes, off };
  deleteParent = null;
  preNames = captureAgentPreNames(session.store.doc, tool, args);
  // 不清清单：失败的调用没改文档，上一次成功的清单仍然准确；
  // 成功时由 finishAgentCall 覆盖（spec：保留到下一次调用覆盖）。
  const nodeId = args.nodeId;
  if (tool === "delete_node" && typeof nodeId === "string") {
    deleteParent = session.store.doc.nodes[nodeId]?.parentId ?? null;
  }
  if (sessionState.activeId === session.id) {
    beginAgentActivity();
    publishAgentTargets(session, tool, collecting.label, true);
    hooks.requestRepaint();
  } else {
    mcpUi.activity = null;
  }
}

function finishAgentCall(session: TabSession, ok: boolean, value?: string): void {
  const window = collecting;
  const wasActive = sessionState.activeId === session.id;
  // 失败的调用已经回滚：不描边、不留"刚改了…"的假信息。
  // 但**不清变更清单**——它记的是上一次成功调用的改动，仍然准确。
  if (!ok) {
    collecting = null;
    window?.off();
    deleteParent = null;
    preNames.clear();
    clearActivityTimer();
    if (wasActive) {
      mcpUi.activity = null;
      resetAgentActivity();
      hooks.requestRepaint();
    }
    return;
  }
  if (window) {
    // 先按最终改动刷一次（此刻 collecting 还在），再清窗口
    if (wasActive) publishAgentTargets(session, window.tool, window.label, false);
    const report = buildAgentChanges(session.store.doc, window.changes, preNames, window.tool);
    const diagnostics = parseAgentDiagnostics(value);
    // 报告永远写回它所属的标签：调用期间切走时，切回来由 activateTab 恢复
    session.view.agentReport = { changes: report.changes, diagnostics, total: report.total };
    if (wasActive) setAgentReport(report, diagnostics);
  }
  collecting = null;
  window?.off();
  deleteParent = null;
  preNames.clear();
  clearActivityTimer();
  if (!wasActive) {
    mcpUi.activity = null;
    return;
  }
  endAgentActivity();
  hooks.requestRepaint();
  activityTimer = setTimeout(() => {
    activityTimer = null;
    mcpUi.activity = null;
    resetAgentActivity();
    hooks.requestRepaint();
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
  // 切标签时收起上一条调用的胶囊与描边：它们属于发起调用的文档，不该跟着活动标签走
  const stopTabWatch = watch(
    () => sessionState.activeId,
    () => {
      mcpUi.activity = null;
      resetAgentActivity();
    },
  );
  // 服务可能比页面先就绪，也可能稍后才监听成功：挂载时主动取一次
  refreshMcpStatus();

  /** `app_state` 的载荷：只读摘要，不含文档内容。`session` 是调用开始时钉住的标签。 */
  function appState(session: TabSession): AppState {
    const pageNode = session.view.activePageId ? session.store.doc.nodes[session.view.activePageId] : null;
    const nameOf = (tab: TabSession) => (tab.kind === "home" ? "Home" : tabLabel(tab));
    return {
      active: {
        tabId: session.id,
        name: nameOf(session),
        path: session.file.path,
        dirty: session.kind === "doc" && session.store.isDirty,
        externalChange: session.file.externalChange,
        page: pageNode?.type === "page" ? { id: pageNode.id, name: pageNode.name } : null,
        selection: session.view.selection.flatMap((id) => {
          const node = session.store.doc.nodes[id];
          return node ? [{ id, name: node.name, type: node.type }] : [];
        }),
      },
      // Home 只给摘要：agent 看到"还有哪些文件开着"就够了
      tabs: sessionState.tabs.map((tab) => ({
        tabId: tab.id,
        name: nameOf(tab),
        path: tab.file.path,
        dirty: tab.kind === "doc" && tab.store.isDirty,
        externalChange: tab.file.externalChange,
        home: tab.kind === "home",
        active: tab.id === sessionState.activeId,
      })),
      limit: MAX_DOC_TABS,
    };
  }

  /** 导出请求的图片解析入口：与画布导出同一套，只是文档换成钉住的那份。 */
  function exportRequest(request: { pageId?: NodeId; nodeIds?: NodeId[]; scale: number }): ExportRequest {
    return {
      pageId: request.pageId,
      nodeIds: request.nodeIds,
      scale: request.scale,
      resolveImage: (assetId) => imageFor(assetId),
      resolveLinkedImage: (url) => linkedImage(url),
      ensureImage: ensureAssetDecoded,
      ensureLinkedImage,
    };
  }

  /**
   * 宿主能力按调用所属的标签钉住：`import_svg` 要写回发起调用的文档，
   * 导出也只读那一份，不跟着活动标签漂。
   */
  function hostFor(session: TabSession): DocumentHost {
    return {
      appState: () => appState(session),
      appInfo: async () => {
        const info = await appInfo();
        return { name: info.name, version: info.version, platform: window.sqraft.platform };
      },
      activatePage: (pageId) => {
        if (sessionState.activeId === session.id) {
          hooks.activatePage(pageId);
          return;
        }
        // 后台标签：只改它自己的视图状态，等切过去时再适配
        session.view.activePageId = pageId;
        session.view.expandedPageId = pageId;
        session.view.selection = [];
        session.view.instanceContext = [];
        session.view.cropNodeId = null;
      },
      exportImage: async (request) => {
        if (request.format === "svg") {
          const result = await renderSvgAsync(
            session.store.doc,
            exportRequest({ pageId: request.pageId, nodeIds: request.nodeIds, scale: 1 }),
          );
          return { svg: result.svg, rasterized: result.rasterized };
        }
        const image = await renderPngAsync(session.store.doc, exportRequest(request));
        return { image, rasterized: [] };
      },
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
      importSvg: async (request) => {
        try {
          const outcome = await insertSvgFrame(
            {
              text: request.svg,
              name: "imported.svg",
              pageId: request.pageId,
              x: request.x,
              y: request.y,
            },
            session.store,
          );
          if (outcome.status === "error") {
            // 只会是页面不存在（工具层已校验过），当成语法问题回报
            return { ok: false, reason: "invalid-svg" };
          }
          if (outcome.status === "fallback") {
            const warnings = outcome.warnings.length ? outcome.warnings : undefined;
            if (outcome.reason === "node-limit" || outcome.reason === "raster-limit") {
              return {
                ok: false,
                reason: outcome.reason,
                limit: outcome.limit ?? 0,
                ...(warnings ? { warnings } : {}),
              };
            }
            return { ok: false, reason: outcome.reason, ...(warnings ? { warnings } : {}) };
          }
          return {
            ok: true,
            frameId: outcome.result.frameId,
            width: outcome.result.width,
            height: outcome.result.height,
            rasterized: outcome.result.rasterized,
            missingFonts: outcome.result.missingFonts,
            warnings: outcome.result.warnings,
          };
        } catch {
          return { ok: false, reason: "invalid-svg" };
        }
      },
    };
  }

  /** 每次调用按发起时的标签建执行器：store、活动页、选区、导出与导入都钉在那一份文档上。 */
  function executorFor(session: TabSession): ToolExecutor {
    return makeExecutor(
      session.store,
      (region) => {
        // 截图依赖当前画布；调用期间切走了就明确失败，不截另一份稿
        if (sessionState.activeId !== session.id) throw new Error(AGENT_TEXT.sessionChanged);
        return hooks.getScreenshot(region);
      },
      () => session.view.activePageId,
      (node, style, text) => textSizeOf(node, style, text, session.store.doc),
      hostFor(session),
      // 选区是画布 UI 状态：只读给 agent 看，改还是走显式 nodeId
      () => [...session.view.selection],
      // agent 建的页面/组件默认名也跟随界面语言
      (kind) => t(kind === "page" ? "node.page" : "node.component"),
      // 诊断用的逐行字体宽度（core 不碰 canvas，度量一律注入）
      { measureLine: measureText },
    );
  }

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
      // 调用开始时就钉住标签：中途切标签也不会把写操作带到别的文档
      const session = activeSession();
      let ok = false;
      let value: string | undefined;
      try {
        // 文档类工具 = 必须带 tabId 的工具；豁免名单在 ai-tools 里单点维护
        const needsTab = requiresTabId(name);
        // Home 上没有文档：文档类工具一律拒绝，且不隐式新建（ADR-0041）
        if (session.kind !== "doc" && needsTab) {
          throw new Error(noActiveDocument(docTabs().map(tabLabel)));
        }
        // 文档类工具必须显式声明目标标签，且必须就是当前活动标签：
        // 用户切过标签后，agent 拿旧上下文继续写会被拒绝，而不是落到碰巧活动的那份稿上（ADR-0041）。
        if (session.kind === "doc" && needsTab) {
          const requested = typeof args.tabId === "string" ? args.tabId.trim() : "";
          if (!requested) {
            throw new Error(tabIdRequired({ id: session.id, name: tabLabel(session) }));
          }
          if (requested !== session.id) {
            throw new Error(
              tabNotActive(
                requested,
                { id: session.id, name: tabLabel(session) },
                docTabs().map((tab) => ({ id: tab.id, name: tabLabel(tab) })),
              ),
            );
          }
        }
        if (mutates) beginAgentCall(session, name, clientLabel, args);
        value = await executorFor(session)(name, args);
        ok = true;
        bridge.mcp.respond({ id, ok: true, value });
      } catch (error) {
        bridge.mcp.respond({ id, ok: false, error: agentErrorText(error) });
      } finally {
        mcpUi.busy = false;
        if (mutates) finishAgentCall(session, ok, value);
      }
    } finally {
      inFlight.delete(id);
    }
  });

  const handle: McpHostHandle = {
    off: () => {
      offCall();
      offStatus();
      stopTabWatch();
      collecting?.off();
      collecting = null;
      deleteParent = null;
      preNames.clear();
      clearAgentReport();
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
