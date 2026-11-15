/**
 * AI 工具入口：装配执行器，按工具名分派到 `handlers/`。
 *
 * 纪律：颜色优先引用 Token，也可以直接用字面量（ADR-0024）。
 * 一次工具调用 = 一个撤销步；写工具提交后把诊断并进同一响应。
 */

import type { DocNode, DocStore, NodeId, NodeStyle } from "@sqraft/core";
import { handlers, MUTATING_TOOLS } from "./handlers";
import { attachDiagnostics } from "./diagnostics";
import { tools, type ToolDefinition } from "./tools";
import type { DocumentHost, ExecutorOptions, ScreenshotRegion, ToolContext, ToolExecutor } from "./types";

export { tools };
export type { ToolDefinition };
export { MUTATING_TOOLS } from "./handlers";
export { assertEffectTokens, assertNumberToken, assertToken } from "./args";
export type { DocumentHost, ExecutorOptions, ScreenshotRegion, ToolExecutor } from "./types";
export type { Command } from "@sqraft/core";

export function makeExecutor(
  store: DocStore,
  getScreenshot: (region?: ScreenshotRegion) => Promise<string>,
  getActivePageId?: () => NodeId | null,
  measureText?: (node: DocNode, style: NodeStyle, text: string) => { width: number; height: number },
  documentHost?: DocumentHost,
  /** 画布当前选区（UI 状态，不进文档）；宿主不提供时 `get_selection` 返回空数组。 */
  getSelection?: () => NodeId[],
  /** 默认名跟随宿主界面语言；不提供时用中文兜底（测试/独立运行）。 */
  defaultName?: (kind: "page" | "component") => string,
  /** 可选注入（诊断度量等）；以后加参数只扩展这个对象。 */
  options: ExecutorOptions = {},
): ToolExecutor {
  const ctx: ToolContext = {
    store,
    getScreenshot,
    getActivePageId,
    measureText,
    host: documentHost,
    getSelection,
    defaultName,
    measureLine: options.measureLine,
  };
  return async (name, args = {}) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`未知工具: ${name}`);
    if (!MUTATING_TOOLS.has(name)) return handler(ctx, args);

    // 诊断要的是「这次事务动了什么」：apply 的 changed 集合比人工列举可靠
    const changed = new Set<NodeId>();
    const unsubscribe = store.subscribe((_state, ids) => {
      for (const id of ids) changed.add(id);
    });
    try {
      const raw = await store.transact(`MCP：${name}`, () => handler(ctx, args));
      return attachDiagnostics(store, raw, changed, options.measureLine);
    } finally {
      unsubscribe();
    }
  };
}

/** 供 OpenAI 兼容接口使用的 tools 字段格式。 */
export function toOpenAITools(): Array<{ type: "function"; function: ToolDefinition }> {
  return tools.map((t) => ({ type: "function" as const, function: t }));
}

/** 供 MCP Server 使用的扁平清单（服务端在 apps/desktop/src/main/mcp 自实现，不引 SDK，见 ADR-0026）。 */
export function toMCPManifest(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
}
