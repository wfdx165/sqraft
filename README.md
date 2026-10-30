# Sqraft

> AI 驱动的轻量 UI 设计工具 —— 纯单机、桌面应用、本地文件。

Sqraft 是一款面向个人与小团队的 UI 设计软件：用画板、组件、自动布局和设计 Token 做界面；同时把同一套能力通过 **MCP** 暴露给外部 agent（Claude Code、Cursor 等），让"用自然语言改稿"成为一等入口。

没有后端、没有账户、没有云，应用内也不调用任何模型：你的设计稿就是磁盘上的一个 `.sqraft` 文件，推理发生在你自己已有的模型订阅或本地模型上。

## 产品定位

- **给谁用**：个人与小团队设计师；多人实时协作不在范围内
- **做什么**：矢量画布、自动布局、组件/实例/插槽、设计 Token、多页面、节点效果、图片（拖入 / 粘贴 / 裁切 / 蒙版）、切图导出
- **怎么用**：桌面应用（macOS / Windows / Linux）；GUI 与外部 agent 两个入口
- **不做什么**：云端协作、账户体系、白板、代码生成（Token→CSS 除外）

## 技术栈

| 层 | 选型 |
|---|---|
| 语言 / 构建 | TypeScript + Vite + electron-vite + pnpm monorepo |
| 运行时 | Electron 45.1.0（Chromium 156.0.8078.49，内嵌 Node 24.22.1） |
| 渲染 | Canvas 2D + `RenderBackend` 抽象（预留 WebGL2 升级路径） |
| 面板 UI | Vue 3.5（画布热路径不经过响应式） |
| 文档模型 | 命令化：一切编辑 = 可序列化命令，状态 = 命令的确定性结果 |
| AI | MCP Server，工具定义来自 `@sqraft/ai-tools`（唯一真源） |
| 存储 | 本地文件（系统对话框 + 原子写）+ `.sqraft` 包格式 |

依赖全部锁定精确版本；Node ≥ 22.12（见 `.nvmrc`）。

## 仓库结构

```
sqraft/
├── GLOSSARY.md                领域词汇表（术语唯一真源）
├── AGENTS.md                  项目规则与不变式
├── docs/
│   ├── architecture.md        总体架构设计
│   ├── roadmap.md             路线图与风险
│   └── adr/                   架构决策记录
├── packages/
│   ├── core/                  文档模型、命令系统、布局求解、Token、效果
│   ├── render/                渲染后端（Canvas 2D）与效果管线
│   └── ai-tools/              AI 工具 schema + 执行器（MCP 的唯一真源）
└── apps/desktop/
    ├── src/main/              主进程：MCP 宿主、文件 IO、窗口/菜单
    ├── src/preload/           白名单 IPC 桥
    ├── src/renderer/          Vue 3 渲染层（画布 + 面板）
    ├── resources/bin/         sqraft-mcp CLI（随包分发，asar 之外）
    ├── scripts/               打包分发脚本、图标生成
    └── electron-builder.yml   三平台打包配置
```

## 快速开始

```bash
pnpm install
pnpm dev        # 启动桌面应用（electron-vite，渲染层热更新）
pnpm test       # core / ai-tools / desktop 的 vitest
pnpm build      # 类型检查（main / preload / renderer）+ 构建
```

打包（按当前系统自动选目标）：

```bash
pnpm dist        # macOS → arm64 dmg；Windows → nsis；Linux → AppImage
pnpm dist:mac    # 也可显式指定；交叉打包需要 wine / docker
```

产物在 `apps/desktop/release/`。当前只验证过 macOS arm64，且未签名。

## 架构要点

- **一切编辑都是命令**：GUI、MCP、撤销重做、持久化共用同一条命令路径。
- **文档真源在渲染进程**：主进程不持有文档状态，只负责 MCP 宿主、文件 IO 与窗口生命周期。
- **渲染只经 `RenderBackend`**：节点效果（投影 / 内阴影 / 图层模糊 / 背景模糊）在离屏层合成，按子树包围盒开层。
- **AI 只能做 GUI 能做的事**：能力必须同时有工具定义与界面入口；颜色可引用 Token，也可直接给字面量（Token 优先）。
- **一次 MCP 调用 = 一个撤销步**：`DocStore.transact` 合并逆操作，失败时回滚。

## 接入 MCP

欢迎页就是接入口：顶部显示 MCP 服务状态与在线 agent 数，并给出一行可直接复制的接入命令（可在 `Claude Code` / `OpenCode` 之间切换）；按状态给动作（`安装命令行工具` / `复制接入命令`）。完整的客户端配置（两套命令、两套 JSON、安装到 PATH）在 `帮助 > 配置 MCP…` 面板里。

- OpenCode：`opencode mcp add sqraft --global -- node <cli 路径>`，或手写配置
  ```jsonc
  { "$schema": "https://opencode.ai/config.json",
    "mcp": { "servers": { "sqraft": { "type": "local", "command": ["node", "<cli 路径>"] } } } }
  ```
- Claude Code：`claude mcp add sqraft -- node <cli 路径>`
- 端点：`~/.sqraft/mcp.sock`（macOS / Linux）、`\\.\pipe\sqraft-mcp`（Windows）
- 薄 CLI（`resources/bin/sqraft-mcp`，无扩展名）只做 `stdio ↔ 本机 IPC` 管道；应用没在跑时会自动拉起，并跳过欢迎页直接建空稿
- 多客户端串行执行，单次调用 30s 超时；应用退出前广播关闭通知
- 操作日志只进终端：运行时所在终端会打出 `[mcp]` 行（连接、工具名、耗时、参数摘要、错误）。不写文件，打包版从 Finder 启动时 stdout 没有出口、看不到——排查问题请从终端启动

图片：`create_node` 的 `kind` 支持 `image`，用 base64 传位图（上限 5MB）；`update_node` 可改 `crop` 与 `mask`。

工具：读 `read_document` / `get_tokens` / `inspect_layout` / `screenshot` / `export_png`；写 `define_token` / `rename_token` / `create_page` / `create_node` / `update_node` / `delete_node` / 组件与布局相关工具 / `import_font` / `document.*`。完整清单与参数以 `packages/ai-tools/src/index.ts` 的 `tools`（`toMCPManifest()`）为准，欢迎页显示实时数量。

## 文件格式

`.sqraft` 是 zip 容器：

```
manifest.json      格式版本、生成应用版本
doc.json           最近一次快照
ops.ndjson         快照之后的增量命令流（当前恒为空）
assets/            图片、嵌入字体（预留，当前未写入）
```

文件是自包含的，不引用本地外链。写入走"同目录临时文件 + rename"的原子替换；保存前比对 mtime，被外部改过时提示覆盖或另存为。

## 命名由来

**Sqraft = Square（方形）+ Craft（工艺）**。UI 设计的原子是方形——画板、按钮、卡片、网格都由方形构成；而设计是手艺，不是堆砌。名字在 2026-10 做过系统查重，npm、域名、GitHub、应用商店均无冲突（见 [ADR-0005](docs/adr/0005-naming-sqraft.md)）。

## 文档

- [总体架构](docs/architecture.md)
- [路线图与风险](docs/roadmap.md)
- [架构决策记录](docs/adr/)
- [领域词汇表](GLOSSARY.md)
- [项目规则](AGENTS.md)
