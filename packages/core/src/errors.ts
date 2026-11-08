/**
 * 可本地化的应用错误：核心只给 code + 参数，文案由界面按当前语言生成。
 *
 * `.message` 仍保留 code（日志与 MCP 兜底用）；界面用 `localizeError()` 映射。
 * 只有"用户操作能触发"的错误需要 code；纯内部不变式继续用普通 Error。
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = "AppError";
  }
}
