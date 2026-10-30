/**
 * 渲染层的 MCP 工具宿主：清单与执行器都来自 @sqraft/ai-tools（唯一真源）。
 * 没有打开文档时，第一次工具调用会先建一份空稿——agent 不该卡在欢迎页。
 */
import { reactive } from "vue";
import { makeExecutor, toMCPManifest } from "@sqraft/ai-tools";
import type { McpStatus } from "../shared/ipc";
import { docStore, hooks, ui } from "./store";
import { newDocument, openDocument } from "./file-session";
import { textSizeOf } from "./text-metrics";
import { putAsset } from "./assets";

/** 连接状态（纯 UI，不进文档）：欢迎页的状态行与文档态的胶囊共用它 */
export const mcpUi = reactive({
  listening: false,
  clients: 0,
  busy: false,
});

/** 工具数从真源取，界面不写死数字 */
const manifest = toMCPManifest();
export const MCP_TOOL_COUNT = manifest.length;

function applyStatus(status: McpStatus): void {
  mcpUi.listening = status.listening;
  mcpUi.clients = status.clients;
}

let installed = false;

export function installMcpHost(): void {
  if (installed) return;
  installed = true;

  const bridge = window.sqraft;
  bridge.mcp.setTools(manifest);
  bridge.mcp.onStatus(applyStatus);
  // 服务可能比页面先就绪，也可能稍后才监听成功：挂载时主动取一次
  void bridge.mcp.status().then(applyStatus);

  const executor = makeExecutor(
    docStore,
    (region) => hooks.getScreenshot(region),
    () => ui.activePageId,
    (node, style, text) => textSizeOf(node, style, text),
    {
      newDocument: () => newDocument(),
      openDocument: () => openDocument(),
      addImage: async (data, mimeType) => {
        const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
        const asset = await putAsset(bytes);
        if (!asset.ok) throw new Error(asset.reason);
        // MIME 以实际内容为准（magic bytes），不信任 agent 传的值
        void mimeType;
        return { assetId: asset.id, width: asset.width, height: asset.height };
      },
    },
  );

  bridge.mcp.onCall(async ({ id, name, args }) => {
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
  });
}
