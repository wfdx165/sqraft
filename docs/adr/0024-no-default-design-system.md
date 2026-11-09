# ADR-0024：新文件不带默认设计系统；字面量从"禁止"降为"约定"

## 状态

已采纳（2026-10）

## 背景

`createEmptyDoc()` 长期预置一个 `页面 1` 和四个 Token（`color/primary`、`color/surface`、`color/text`、`radius/md`），画板/形状/文本的默认颜色都引用它们；`ai-tools` 的 `assertToken()` 又强制"样式只接受 Token 引用"，字面量直接报错。

结果是：用户新建文件时被迫继承一套不是自己定的设计系统；agent 在用户还没建 Token 时画不出有颜色的东西（且当时没有创建 Token 的工具）。这与"为 AI 原生而设计的 UI/UX 工具"的定位冲突——设计系统应该是用户（或 agent 与用户一起）显式建立的东西。

## 决策

1. **新文件是空文档**：`createEmptyDoc()` 不建页面、不建 Token。空文档由画布引导卡承接（「新建页面」），绘图工具在无页面时不可用；agent 可用 `create_page` 显式建页，第一次建节点时若无页面也会自动补一页（`页面 1`）。
2. **默认颜色用字面量**：人手新建矩形/椭圆/多边形/闭合路径 `#3366ff`、画板 `#ffffff`、文本与开放路径 `#1a1a1a`（描边宽 2）；agent 的默认值同样如此。
3. **AI 可以用字面量**：`create_node` / `update_node` 新增 `fill` / `stroke` 字面量入参；`fillToken` / `strokeToken` 仍然可用且优先。`assertToken()` 只校验"引用了不存在的 Token"，不再声称禁止字面量。
4. **设计系统是显式资产**：Token 只由 `token.define` 建立——人手在设计系统面板，agent 用 MCP 的 `define_token`（`rename_token` 负责改名，fill / stroke / 阴影颜色引用随动）。

## 后果

- `AGENTS.md` 不变式 6 改写：从"只接受 Token 引用"改为"Token 优先、字面量允许"。
- 老文件不受影响：已存在的 Token 与引用照旧解析；只是新建文件不再预置。
- `get_tokens` 在空文档返回空表，agent 据此决定用 Token 还是字面量。
- 测试里需要 Token 的地方改为显式构造（不再依赖默认值）。
- 后续若要"把字面量收编成 Token"，那是设计系统面板的功能（批量替换），不在本轮。
