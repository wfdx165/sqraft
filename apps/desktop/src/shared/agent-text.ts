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
