/**
 * AI 工具定义：内置对话面板与 MCP Server 的唯一真源（ADR-0004）。
 * 纪律：样式只接受 Token 引用，字面量色值在工具层直接拒绝。
 */

import type { Command, DocStore, NodeId } from "@sqraft/core";
import { createNode, firstPageId, walkSubtree } from "@sqraft/core";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  readonly?: boolean;
}

export const tools: ToolDefinition[] = [
  {
    name: "read_document",
    description: "读取当前文档的页面与节点树紧凑摘要。返回 JSON 字符串。",
    readonly: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_tokens",
    description: "读取设计 Token 集合及当前模式下的取值。样式必须引用这些 Token。",
    readonly: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_node",
    description:
      "在父节点下创建一个节点。kind 支持 frame/rect/ellipse/line/text。样式颜色必须用 fillToken（Token 名，如 color/primary），不允许字面量色值。",
    input_schema: {
      type: "object",
      properties: {
        parentId: { type: "string", description: "父节点 id；省略则建到当前页面" },
        kind: { type: "string", enum: ["frame", "rect", "ellipse", "line", "text"] },
        name: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        text: { type: "string", description: "kind=text 时的文案" },
        fontSize: { type: "number" },
        fillToken: { type: "string", description: "填充色的 Token 名，如 color/primary" },
        cornerRadius: { type: "number" },
      },
      required: ["kind", "width", "height"],
      additionalProperties: false,
    },
  },
  {
    name: "update_node",
    description: "更新节点属性。fill 仅接受 Token 引用（fillToken）。",
    input_schema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        text: { type: "string" },
        fillToken: { type: "string" },
        cornerRadius: { type: "number" },
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_node",
    description: "删除节点及其子树。",
    input_schema: {
      type: "object",
      properties: { nodeId: { type: "string" } },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description: "截取当前画布视口为 PNG（data URL），用于自检生成结果。",
    readonly: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

function serializeSubtree(store: DocStore, id: NodeId): string {
  const out: unknown[] = [];
  walkSubtree(store.doc, id, (n) =>
    out.push({ id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, w: n.width, h: n.height, text: n.text }),
  );
  return JSON.stringify(out);
}

export function assertToken(store: DocStore, token: string | undefined, field: string): void {
  if (token === undefined) return;
  if (!store.doc.tokens[token]) {
    throw new Error(`${field} 引用了不存在的 Token "${token}"；调用 get_tokens 查看可用 Token。禁止使用字面量色值。`);
  }
}

export function makeExecutor(store: DocStore, getScreenshot: () => Promise<string>): ToolExecutor {
  return async (name, args) => {
    switch (name) {
      case "read_document": {
        const pages = store.doc.rootIds.map((pid) => ({ pageId: pid, subtree: serializeSubtree(store, pid) }));
        return JSON.stringify({ activeMode: store.doc.activeMode, pages });
      }
      case "get_tokens": {
        return JSON.stringify({ activeMode: store.doc.activeMode, modes: store.doc.modes, tokens: store.doc.tokens });
      }
      case "create_node": {
        const kind = String(args.kind) as "frame" | "rect" | "ellipse" | "line" | "text";
        assertToken(store, args.fillToken as string | undefined, "fillToken");
        const parentId = (args.parentId as NodeId | undefined) ?? firstPageId(store.doc);
        if (!parentId || !store.doc.nodes[parentId]) throw new Error("parentId 不存在");
        const style = args.fillToken ? { fill: { token: args.fillToken as string } } : {};
        const node = createNode(kind, {
          name: (args.name as string) ?? kind,
          x: (args.x as number) ?? 0,
          y: (args.y as number) ?? 0,
          width: (args.width as number) ?? 100,
          height: (args.height as number) ?? 100,
          text: args.text as string | undefined,
          style: {
            ...style,
            fontSize: args.fontSize as number | undefined,
            cornerRadius: args.cornerRadius as number | undefined,
          },
        });
        store.apply({ type: "node.create", params: { nodes: [node], parentId } }, "ai:create");
        return JSON.stringify({ ok: true, nodeId: node.id });
      }
      case "update_node": {
        const nodeId = args.nodeId as NodeId;
        if (!store.doc.nodes[nodeId]) throw new Error(`节点 ${nodeId} 不存在`);
        assertToken(store, args.fillToken as string | undefined, "fillToken");
        const patch: Record<string, unknown> = {};
        for (const k of ["x", "y", "width", "height", "text", "cornerRadius"] as const) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        if (args.fillToken !== undefined) patch.style = { fill: { token: args.fillToken as string } };
        store.apply({ type: "node.update", params: { nodeId, patch } }, "ai:update");
        return JSON.stringify({ ok: true });
      }
      case "delete_node": {
        const nodeId = args.nodeId as NodeId;
        if (!store.doc.nodes[nodeId]) throw new Error(`节点 ${nodeId} 不存在`);
        store.apply({ type: "node.delete", params: { nodeId } }, "ai:delete");
        return JSON.stringify({ ok: true });
      }
      case "screenshot":
        return JSON.stringify({ ok: true, image: await getScreenshot() });
      default:
        throw new Error(`未知工具: ${name}`);
    }
  };
}

/** 供 OpenAI 兼容接口使用的 tools 字段格式。 */
export function toOpenAITools(): Array<{ type: "function"; function: ToolDefinition }> {
  return tools.map((t) => ({ type: "function" as const, function: t }));
}

/** 供 MCP Server 使用的扁平清单（骨架；M4 正式实现挂 @modelcontextprotocol/sdk）。 */
export function toMCPManifest(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
}

export type { Command };
