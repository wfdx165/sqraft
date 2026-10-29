# AGENTS.md

Sqraft：AI 驱动的轻量 UI 设计工具（纯单机、Web 优先）。文档与注释用中文，代码标识符英文。

## 工作流约束

- **任务完成后不要执行任何 git 命令**（add / commit / push / tag / reset 等，含 `--no-verify`）。改动留在工作区即可，由用户自行提交。
- **不要自行运行 `pnpm dev`**（开发服务器由用户自己启动）。需要界面验证时，用 Playwright 打开用户已启动的 `http://localhost:5173` 做可视化验证；若端口未启动，只做 `pnpm test && pnpm build` 并说明。

## 常用命令

- 安装：`pnpm install`（pnpm 10；esbuild postinstall 被忽略的警告无害，构建正常）
- 开发：`pnpm dev` —— 只启动 `apps/web`（Vite，:5173）。各包经 `apps/web/vite.config.ts` 的别名直接引用源码，改包代码无需单独构建
- 类型检查 + 构建：`pnpm build`（packages 内 `tsc` 仅类型检查，`noEmit`；web 走 `vite build`）
- 测试：`pnpm test` —— 只跑 `@sqraft/core` 的 vitest；render/ai-tools 无测试运行器
- 单个测试：`pnpm --filter @sqraft/core exec vitest run -t "关键词"`
- 没有 lint/format 配置（未装 ESLint/Prettier）。类型检查就是质量门槛，不要擅自引入

## 架构不变式（违反即 bug）

1. 一切文档变更必须走 `DocStore.apply(Command)`；禁止直接改 `doc.nodes`
2. 命令必须确定性：apply 执行期禁止 `Date.now`/随机/IO；节点 id 在命令创建**之前**生成并随 payload 传递
3. `packages/core` 不得依赖 DOM/浏览器 API——必须能在 Node 下完整测试
4. 画布热路径不进 Vue 响应式：渲染器每帧直接读 DocStore；`ui.version` 只是触发重绘的脏标记
5. `patch.style` 是**整体替换**（调用方先展开旧 style）；撤销正确性依赖这一点，别改成合并
6. AI 能力只经 `packages/ai-tools` 的工具定义落地（对话与 MCP 共用同一份）；样式颜色只接受 Token 引用（`fillToken`），`assertToken` 会拒绝字面量色值
7. 渲染只经 `RenderBackend` 接口；例外是 `CanvasView.vue` 里的选中框/拖拽预览叠加层（UI 局部）
8. 坐标相对父容器内容区左上角；旋转绕自身中心
9. 页面 = `DocState.rootIds` 中的 `page` 节点；"当前页面"是 UI 状态（`ui.activePageId`），不是命令的一部分

## 术语与文档

- `GLOSSARY.md` 是术语唯一真源（Frame=画板、Group=分组、命令、Token、变体=枚举型组件属性…）。不要引入同义词
- 架构以 `docs/architecture.md` 为准；重大决策新增 ADR（`docs/adr/`，顺序编号、短格式）
- `docs/roadmap.md` 划定范围：v1 无协作后端、无布尔运算、无富文本 runs——不要顺手实现
- 改行为时同步更新对应文档

## 已知坑

- `<canvas>` 除 `inset:0` 外必须显式 `width/height:100%`，否则内在像素尺寸会撑破布局（`CanvasView.vue` 修过一次）
- `.sqraft` = zip（`manifest.json` + `doc.json` + `ops.ndjson`）；当前 `ops.ndjson` 恒为空（骨架阶段，增量日志未接）
- `newId()` 基于时间戳+计数器，只用于"新建节点前"，不要在命令执行期调用
- `.playwright-mcp/` 是浏览器 MCP 工具产物，已 gitignore，勿提交

## 验证

- 代码改动：`pnpm test && pnpm build`
- 交互改动：用户启动 `pnpm dev` 后，用 Playwright 打开 `http://localhost:5173` 验证：矩形工具拖拽画框 → 图层面板出现节点、检查器显示属性、填充解析为 Token 色、撤销可用
