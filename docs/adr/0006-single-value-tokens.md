# Token 取消多模式，只保留单一取值

产品复盘时确认：Sqraft 的 Token 不需要 light/dark 或品牌模式维度。DocState 的 `tokens[path]` 从 `{ values: { mode: value } }` 简化为 `{ value }`，`mode.set` 命令与检查器里的模式切换一并删除；DTCG 导出输出单值。

## Consequences

- 主题切换能力被移除；若未来恢复多模式，需要重新引入 `modes`/`activeMode` 与解析分支（结构简单，属可逆改动）。
- AI 工具的 `get_tokens` 只返回单值，工具 schema 与文档同步简化。
