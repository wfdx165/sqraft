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
].join("\n");
