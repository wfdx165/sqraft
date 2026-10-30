/**
 * 绘图工具落笔：把拖拽出的包围盒转成真实节点。
 * 返回待提交的节点与父容器；命令、选区与编辑态由 CanvasView 负责。
 */
import { createNode, defaultLayoutFor, worldRect, type DocNode, type NodeId } from "@sqraft/core";
import { docStore } from "../store";
import { DEFAULT_TEXT_FONT_FAMILY, DEFAULT_TEXT_FONT_SIZE, textSizeOf } from "../text-metrics";
import { nextPolygonName } from "./pen";
import { containerAt, reorderIndexAt } from "./layout-drag";
import { TOOL_NAMES, type DrawTool } from "./tools";

export interface CreateDragInput {
  tool: DrawTool;
  pageId: NodeId;
  preview: { x: number; y: number; w: number; h: number };
}

export interface CreatedNode {
  node: DocNode;
  parentId: NodeId;
  /** 父容器有自动布局时，按落点算出的插入位置 */
  index?: number;
  startEdit: boolean;
}

export function buildCreatedNode(input: CreateDragInput): CreatedNode {
  const page = docStore.doc.nodes[input.pageId];
  if (!page) throw new Error("起笔页面不存在");
  const { preview, tool } = input;
  const x0 = Math.min(preview.x, preview.x + preview.w);
  const y0 = Math.min(preview.y, preview.y + preview.h);
  const w = Math.max(8, Math.abs(preview.w));
  const h = Math.max(8, Math.abs(preview.h));

  // 落在画板/组件里就建为子节点（自动布局需要这个入口）
  const container = containerAt(x0 + w / 2, y0 + h / 2);
  const parent = container ?? page;
  const parentRect = worldRect(docStore.doc, parent.id)!;

  const isLine = tool === "line";
  const isTriangle = tool === "triangle";
  const node = createNode(
    isTriangle ? "polygon" : tool,
    isLine
      ? {
          name: TOOL_NAMES[tool] ?? tool,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          // 用两点路径记住起止方向：单纯用包围盒会把左上→右下的方向强行归一化
          vector: {
            closed: false,
            anchors: [
              { x: preview.x - parentRect.x, y: preview.y - parentRect.y, inX: 0, inY: 0, outX: 0, outY: 0 },
              {
                x: preview.x + preview.w - parentRect.x,
                y: preview.y + preview.h - parentRect.y,
                inX: 0,
                inY: 0,
                outX: 0,
                outY: 0,
              },
            ],
          },
          style: { stroke: { value: "#1a1a1a" }, strokeWidth: 2 },
        }
      : {
          name: isTriangle ? nextPolygonName(docStore, 3) : (TOOL_NAMES[tool] ?? tool),
          x: x0 - parentRect.x,
          y: y0 - parentRect.y,
          width: w,
          height: h,
          sides: isTriangle ? 3 : undefined,
          // 新建画板/组件默认开启自动布局（纵向、gap 10、padding 10）
          layout: defaultLayoutFor(isTriangle ? "polygon" : tool),
          // 画板默认白底、形状默认主色：都是字面量，不预设设计系统
          style: { fill: { value: tool === "frame" ? "#ffffff" : "#3366ff" } },
        },
  );

  let startEdit = false;
  if (tool === "text") {
    // 文本：自动尺寸 + 与界面一致的字体，创建后直接进入编辑（全选）
    const style = {
      fill: { value: "#1a1a1a" },
      fontSize: DEFAULT_TEXT_FONT_SIZE,
      fontFamily: DEFAULT_TEXT_FONT_FAMILY,
    };
    node.text = "文本";
    node.textAutoResize = "auto-width";
    node.style = style;
    const size = textSizeOf(node, style, "文本");
    node.width = size.width;
    node.height = size.height;
    startEdit = true;
  }

  // 父容器有自动布局：按落点算出插入位置（与拖动重排序共用同一套投影）
  const index = parent.layout ? reorderIndexAt(parent.id, x0 + w / 2, y0 + h / 2, []) : undefined;

  return { node, parentId: parent.id, index, startEdit };
}
