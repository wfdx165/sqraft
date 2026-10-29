/** 绘图工具的类型与默认命名。 */
export const TOOL_NAMES: Record<string, string> = {
  frame: "画板",
  rect: "矩形",
  ellipse: "椭圆",
  triangle: "三角形",
  line: "直线",
  path: "路径",
  text: "文本",
};

/** 正三角形的高宽比：⇧ 约束用（√3/2）。 */
export const EQUILATERAL_RATIO = Math.sqrt(3) / 2;

/** 会走「拖出包围盒」创建流程的工具（钢笔单独处理）。 */
export type DrawTool = "frame" | "rect" | "ellipse" | "triangle" | "line" | "text";

export const DRAW_TOOLS: readonly string[] = ["frame", "rect", "ellipse", "triangle", "line", "text"];

export function drawToolOf(tool: string): DrawTool | null {
  return DRAW_TOOLS.includes(tool) ? (tool as DrawTool) : null;
}
