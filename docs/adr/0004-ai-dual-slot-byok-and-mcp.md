# AI 双插槽：内置对话（BYOK）+ MCP，共用一套工具 schema

AI 驱动全流程的落地方式是"双插槽"：软件内置对话面板（用户自带 API Key：DeepSeek/OpenAI/Claude/本地 Ollama），同时把同一套工具定义暴露为 MCP Server 供外部 agent（Claude Code 等）驱动。两个插槽共用 packages/ai-tools 中唯一的工具定义（JSON Schema + 执行器），底层都落到命令层。

纯单机约束下这是唯一自洽的 AI 形态：推理发生在用户已有的模型订阅/本地模型上，Sqraft 只做确定性执行与渲染反馈，不引入任何服务端。共用 schema 使两个插槽的边际成本接近零，且保证内置与外部 agent 的能力永远对齐。

## Considered Options

- 只做内置对话：失去"在 Claude Code 里直接指挥设计稿"的生态位。
- 只做 MCP：普通用户没有外部 agent，产品第一体验缺失。

## Consequences

- 新增能力必须同时进工具 schema 与 GUI——工具层是能力的清单真源。
- 样式类参数只接受 Token 引用，字面量色值在工具层拒绝；AI 产出必须走设计系统。
- 工具执行器与 GUI 命令走同一校验路径，杜绝"AI 特权操作"。
