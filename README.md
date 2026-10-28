# Sqraft

> AI 驱动的轻量级 UI 设计工具 —— 纯单机、Web 优先、本地文件。

**Sqraft** 是一款面向个人与小团队的 UI 设计软件：用画板、组件、自动布局和设计 Token 高效地设计界面；从第一行代码起，整个工作流都可以由 AI agent 驱动——自然语言生成多页面设计稿、迭代修改、导出切图与 Token。没有后端、没有账户、没有云：你的设计稿就是你磁盘上的一个 `.sqraft` 文件。

## 命名由来

**Sqraft = Square（方形）+ Craft（工艺）。**

UI 设计的原子是方形——画板是矩形、按钮是圆角矩形、卡片是矩形、网格由方形构成；而设计是手艺（craft），不是堆砌。Sqraft 表达的是"以方形为基本语言的设计工艺"，也暗合"在方寸之间构造界面"的中文意象。

这个名字是经过系统性查重后定下的（2026-10）。候选池包含文化意象类（墨方、笔墨、Sumi、Inkstone、方寸、尺规）、构成主义类（Modulor、De Stijl）与生造词类（Sqraft、Kanvaso、Griddo、Layr、Tessera），逐一用两套独立工具（Chrome DevTools MCP + Playwright MCP）核验：

| 候选 | 结论 |
|---|---|
| 墨方 / 笔墨 / Modulor / Sumi / Inkstone / Griddo / De Stijl / WuFang / Kanvaso / 方寸 | 均已存在同名或高度混淆的产品，淘汰 |
| 尺规（Chigui） | 无产品占用，但 chigui.com 已被注册，且搜索引擎中与量尺工具混淆 |
| **Sqraft** | **全资产清白**：npm 包名、sqraft.com 域名、GitHub 用户名、应用商店、搜索引擎均无冲突 |

详见 [ADR-0005 命名 Sqraft](docs/adr/0005-naming-sqraft.md)。

## 产品定位

- **给谁用**：个人与小团队设计师（多人实时协作不在范围内）
- **做什么**：矢量画布编辑、组件与变体、自动布局、设计 Token、多页面原型、切图导出
- **怎么用**：Web 优先（Chromium 系为主）；传统 GUI 与 AI 对话双入口
- **不做什么**：云端、账户体系、白板、代码生成（Token→CSS 除外）

## 技术栈

| 层 | 选型 |
|---|---|
| 语言 / 构建 | TypeScript + Vite + pnpm monorepo |
| 渲染 | Canvas 2D + RenderBackend 抽象（预留 WebGL2 升级路径） |
| 面板 UI | Vue 3（画布热路径不经过响应式） |
| 文档模型 | 命令化（一切编辑 = 可序列化命令，状态 = 命令的确定性结果） |
| AI | 内置对话（BYOK）+ MCP Server，共用同一套工具 schema |
| 存储 | 本地文件（File System Access）+ `.sqraft` 包格式 |

## 仓库结构

```
sqraft/
├── GLOSSARY.md            领域词汇表（术语唯一真源）
├── docs/
│   ├── architecture.md    总体架构设计
│   ├── roadmap.md         分阶段路线图与风险
│   └── adr/               架构决策记录
├── packages/
│   ├── core/              文档模型、命令系统、布局求解、Token
│   ├── render/            渲染后端（Canvas 2D 实现）
│   └── ai-tools/          AI 工具 schema（对话与 MCP 共用）
└── apps/
    └── web/               Vue 3 应用（画布 + 面板 + 对话）
```

## 快速开始

```bash
pnpm install
pnpm dev        # 启动开发服务器
pnpm test       # 运行核心包测试（布局求解 golden / 命令确定性）
```

## 文档

- [总体架构](docs/architecture.md)
- [路线图与风险](docs/roadmap.md)
- [架构决策记录](docs/adr/)
