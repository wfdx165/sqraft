# 对话会话存 IndexedDB，模型为全局设置

对话历史（含工具调用参数）体积不可预测，localStorage 的 5MB 上限迟早触发；会话与文档分离、纯本地，选 IndexedDB（数据库 `sqraft`，store `sessions`）。模型选择是**全局设置**而非会话级：切换会话不改变模型，会话只承载消息历史。

## Consequences

- 会话列表与正文都从 IndexedDB 异步加载，切会话有短暂加载态；文档数据（`.sqraft` 文件）不受影响。
- 删除会话仅删历史，不影响画布文档。
- 若未来要"每会话独立模型"，需要把 provider/model 写进 session 记录并调整选择器绑定。
