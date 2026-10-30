# Sqraft

> AI 驱动的轻量 UI 设计工具 —— 纯单机、桌面应用、本地文件。

Sqraft 是一款面向个人与小团队的 UI 设计软件：用画板、组件、自动布局和设计 Token 做界面；同时把同一套能力通过 **MCP** 暴露给外部 agent（Claude Code、Cursor 等），让"用自然语言改稿"成为一等入口。

没有后端、没有账户、没有云，应用内也不调用任何模型：你的设计稿就是磁盘上的一个 `.sqraft` 文件，推理发生在你自己已有的模型订阅或本地模型上。

## 产品定位

- **给谁用**：个人与小团队设计师；多人实时协作不在范围内
- **做什么**：矢量画布、自动布局、组件/实例/插槽、设计 Token、多页面、节点效果、切图导出
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
- **AI 只能做 GUI 能做的事**：能力必须同时有工具定义与界面入口；样式颜色只接受 Token 引用。
- **一次 MCP 调用 = 一个撤销步**：`DocStore.transact` 合并逆操作，失败时回滚。

## 接入 MCP

在应用里打开 `帮助 > 配置 MCP…`，面板会给出可直接粘贴的配置（路径由应用自己计算），并提供"安装命令行工具到 PATH"。

- 端点：`~/Library/Application Support/Sqraft/mcp.sock`（macOS）、`$XDG_CONFIG_HOME/Sqraft/mcp.sock`（Linux，缺省 `~/.config`）、`\\.\pipe\sqraft-mcp`（Windows）
- 薄 CLI 只做 `stdio ↔ 本机 IPC` 管道；应用没在跑时会自动拉起，并跳过欢迎页直接建空稿
- 多客户端串行执行，单次调用 30s 超时；应用退出前广播关闭通知

工具（14 个）：`read_document`、`get_tokens`、`create_node`、`update_node`、`delete_node`、`create_instance`、`swap_instance`、`detach_instance`、`define_property`、`set_instance_prop`、`fill_slot`、`screenshot`、`document.new`、`document.open`。

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
