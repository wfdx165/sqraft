> **Superseded（2026-10）**：内置对话已删除，应用内不再有浏览器直连模型端点的路径；本 ADR 仅作为历史记录保留。替代决策见 ADR-0004（MCP 单插槽）。

# 内置对话受浏览器 CORS 限制（已实测）

内置对话面板在浏览器内直接 `fetch` 各接入点的 `/chat/completions`。实测 `opencode.ai` 的 Go / inference 端点在 OPTIONS 预检上返回 404 且无 `Access-Control-Allow-*` 头，浏览器会以 "Failed to fetch" 拒绝；OpenAI、DeepSeek 等商业 API 同样普遍不开放浏览器跨域。

## Consequences

- 内置对话**只对允许 CORS 的接入点开箱可用**：本地 Ollama（`OLLAMA_ORIGINS=*`）、自建网关/反代、部分企业自托管服务。
- 直连 OpenCode Go 需要额外通道：桌面壳（Tauri/Electron，无浏览器跨域限制）、本地反代，或用户自己在网关层加 CORS。
- 这是"纯浏览器 + BYOK"架构的固有限制，不是实现缺陷；错误信息已提示 CORS 原因。
- 若未来提供桌面壳，LLM 请求层应切换为系统 HTTP（或仍走 fetch 到 localhost 网关），Provider 配置结构不变。
