/**
 * 面向外部 agent 的错误文案：固定英文，不随界面语言变化。
 *
 * 这些字符串会经 MCP `tools/call` 返回给 Claude Code / OpenCode / Cursor 等客户端，
 * 和 UI 文案（跟随界面语言）是两条不同的出口；不要放进 shared/i18n 的字典里。
 */
export const AGENT_TEXT = {
  busy: "Another tool call is still running. Try again shortly.",
  noWindow: "Sqraft window is not open; cannot run the tool.",
  rendererTimeout: "The renderer did not return a result in time.",
} as const;

/** 活动标签是 Home 时，文档类工具的统一拒绝文案（列出已打开的文档，便于 agent 请用户切过去）。 */
export function noActiveDocument(openTabs: string[]): string {
  const open = openTabs.length > 0 ? ` Open documents: ${openTabs.join(", ")}.` : "";
  return `No document is open (the Home tab is active).${open} Ask the user to switch to a document tab.`;
}

/**
 * MCP `initialize` 里返回给客户端的全局工作规则。
 * 大多数客户端会把它当系统提示注入：这里写跨工具的流程，工具 description 只管参数。
 */
export const AGENT_INSTRUCTIONS = [
  'Start with search_nodes when you need to find something, then read_document with scope:"subtree" on the hit id.',
  'read_document defaults to the active page at depth 1; ask for scope:"document" only when you need an overview.',
  "Every write result may carry diagnostics. Fix warnings before moving on.",
  'If your client cannot read images, call screenshot({format:"text"}).',
  "One tool call is one undo step, so a single undo reverts the whole call.",
  "Frames and components default to auto layout (vertical, gap 10, padding 10). For a container with 2+ children, build it with layout + layoutSizingW/H (hug/fill) instead of positioning each child by hand.",
  "Inside a layout container x/y are owned by the layout; set layoutAbsolute:true on a child that must keep a free position.",
  "A write result may carry layoutHints when hand-placed siblings already form an evenly spaced row or column; apply suggested when it matches the design.",
  "boolean_op bakes its result into a plain path; operands survive only in the undo stack, so keep their ids if you may need to revert.",
  "Read and write path anchors as contours + fillRule (parent-container coordinates, whole-array replacement); points/closed only work on single-contour paths.",
].join("\n");
