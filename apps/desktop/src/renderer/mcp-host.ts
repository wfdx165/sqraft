/**
 * 渲染层的 MCP 工具宿主：清单与执行器都来自 @sqraft/ai-tools（唯一真源）。
 * 没有打开文档时，第一次工具调用会先建一份空稿——agent 不该卡在欢迎页。
 */
import { reactive } from "vue";
import { makeExecutor, toMCPManifest } from "@sqraft/ai-tools";
import { docStore, hooks, ui } from "./store";
import { newDocument, openDocument } from "./file-session";
import { textSizeOf } from "./text-metrics";

/** 连接状态条的数据源（纯 UI，不进文档） */
export const mcpUi = reactive({
  clients: 0,
  busy: false,
});

let installed = false;

export function installMcpHost(): void {
  if (installed) return;
  installed = true;

  const bridge = window.sqraft;
  bridge.mcp.setTools(toMCPManifest());
  bridge.mcp.onStatus(({ clients }) => {
    mcpUi.clients = clients;
  });

  const executor = makeExecutor(
    docStore,
    (region) => hooks.getScreenshot(region),
    () => ui.activePageId,
    (node, style, text) => textSizeOf(node, style, text),
    {
      newDocument: () => newDocument(),
      openDocument: () => openDocument(),
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
