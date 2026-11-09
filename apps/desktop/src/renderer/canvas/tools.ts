/** 绘图工具的类型与默认命名。 */
import { t } from "../i18n";
import type { MessageKey } from "../../shared/i18n";

const TOOL_NAME_KEYS: Record<string, MessageKey> = {
  frame: "node.frame",
  rect: "node.rect",
  ellipse: "node.ellipse",
  triangle: "node.triangle",
  line: "node.line",
  path: "node.path",
  text: "node.text",
};

/** 新建图层的默认名跟随界面语言。 */
export function toolName(tool: string): string {
  const key = TOOL_NAME_KEYS[tool];
  return key ? t(key) : tool;
}

/** 正三角形的高宽比：⇧ 约束用（√3/2）。 */
export const EQUILATERAL_RATIO = Math.sqrt(3) / 2;

/** 会走「拖出包围盒」创建流程的工具（钢笔单独处理）。 */
export type DrawTool = "frame" | "rect" | "ellipse" | "triangle" | "line" | "text";

export const DRAW_TOOLS: readonly string[] = ["frame", "rect", "ellipse", "triangle", "line", "text"];

export function drawToolOf(tool: string): DrawTool | null {
  return DRAW_TOOLS.includes(tool) ? (tool as DrawTool) : null;
}
