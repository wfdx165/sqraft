# AGENTS.md

Sqraft：AI 驱动的轻量 UI 设计工具（纯单机、桌面优先，Electron）。文档与注释用中文，代码标识符英文。

## 工作流约束

- **任务完成后不要执行任何 git 命令**（add / commit / push / tag / reset 等，含 `--no-verify`）。改动留在工作区即可，由用户自行提交。
- **不要重启用户的开发实例**：`pnpm dev` 在跑时，渲染层走 HMR、preload 自动 reload、主进程由 electron-vite 自己重启。不要 `pkill` dev / Electron 进程，也不要为了验证另起实例——两者共用单实例锁，会互相踢掉。
- **不主动起 `pnpm dev`**：dev 没在跑时，任务收尾只跑 `pnpm test && pnpm build`，界面验证交给用户。dev 在跑时用它的调试端口做只读检查（`Page.captureScreenshot` 截图、`Runtime.evaluate` 读 DOM），不点系统对话框、不改用户文档。
- **不跑打包版做日常验证**：`pnpm dist:dir` 与启动 `.app` 只在用户明确要求时做（改到打包配置、CLI 分发、asar 行为这类才需要）。
- Playwright 已移除（连同浏览器部署目标）。不要再引入浏览器自动化，界面验证靠 CDP 只读检查 + 手点清单。

## 常用命令

- 安装：`pnpm install`（pnpm 10；只有 `electron` / `esbuild` 允许跑安装脚本，见根 `package.json` 的 `pnpm.onlyBuiltDependencies`）
- 开发：`pnpm dev` → `electron-vite dev`，同时起主进程、preload 与渲染层（Vite，渲染层 HMR）。dev **默认不开**调试端口；需要只读检查时用 `SQRAFT_DEBUG_PORT=9222 pnpm dev` 显式开启（`=0` 关闭）。渲染层源码在 `apps/desktop/src/renderer`，主进程在 `src/main`，preload 在 `src/preload`
- 类型检查 + 构建：`pnpm build` —— packages 内 `tsc` 只做类型检查（`noEmit`）；桌面应用先跑 `typecheck`（main / preload / renderer 三份 `tsc --noEmit`）再 `electron-vite build` 到 `apps/desktop/out`
- 测试：`pnpm test` —— 递归跑有 `test` 脚本的包（`@sqraft/core`、`@sqraft/ai-tools`、`@sqraft/desktop` 的 vitest）；`@sqraft/render` 无测试运行器
- 打包：`pnpm dist` —— 按当前系统自动选命令（macOS → arm64 dmg，Windows → nsis，Linux → AppImage），产物在 `apps/desktop/release/`
- 所有 `dist*` 脚本都先跑 `pnpm clean`：清空 `apps/desktop/out/` 与 `release/`，避免旧产物被打进 asar 或堆在 release 里；想保留上一次的 dmg 用 `pnpm --filter @sqraft/desktop exec node scripts/clean.mjs --keep-release`
- 快速出包（只出 `.app`、不建 dmg，约 4s）：`pnpm dist:dir` —— 验证"打包后能不能跑 / MCP 通不通"用它
- 指定平台打包：`pnpm dist:mac` / `dist:win` / `dist:linux`；同一台机器上的交叉打包需要 wine / docker，本项目只在 macOS 上验证过
- 单个测试：`pnpm --filter @sqraft/core exec vitest run -t "关键词"`
- 没有 lint/format 配置（未装 ESLint/Prettier）。类型检查就是质量门槛，不要擅自引入

## 版本锁定

- 所有依赖都写**精确版本**（没有 `^`/`~`）。锁文件记录"装了什么"，`package.json` 声明"要什么"，两者都必须保持一致。
- 运行时版本：Electron `45.1.0` → Chromium `156.0.8078.49`、内嵌 Node `24.22.1`。Chromium 不能单独锁，它随 Electron 走；不要试图单独升 Chromium。
- 界面固定浅色（不做深色主题）：`color-scheme: light`，窗口背景 `#eef0f4`，主进程设 `nativeTheme.themeSource = "light"`（原生菜单也不跟随系统深色）。
- Node 版本：`.nvmrc` 是 `22.12.0`（唯一验证过的版本），根 `package.json` 的 `engines.node` 是 `>=22.12`（Electron 45 的硬要求）。
- **升级不排期**：只有安全修复或必须的功能才升。每次升级单独一票，验收固定为：
  1. 改 `package.json` 的精确版本 → `pnpm install`（确认锁文件只动这几个包）；
  2. `pnpm test && pnpm build`；
  3. `pnpm dist` 出包，装/直接跑 `.app`；
  4. 手点：文件往返（开→改→存→关→重开）+ MCP（建节点 → 截图）；
  5. 若 Electron 升级：更新 README 里的 Chromium 版本行。

## 架构不变式（违反即 bug）

1. 一切文档变更必须走 `DocStore.apply(Command)`；禁止直接改 `doc.nodes`
2. 命令必须确定性：apply 执行期禁止 `Date.now`/随机/IO；节点 id 在命令创建**之前**生成并随 payload 传递
3. `packages/core` 不得依赖 DOM/浏览器 API——必须能在 Node 下完整测试
4. 画布热路径不进 Vue 响应式：渲染器每帧直接读 DocStore；`ui.version` 只是触发重绘的脏标记
5. `patch.style` 是**整体替换**（调用方先展开旧 style）；撤销正确性依赖这一点，别改成合并
6. AI 能力只经 `packages/ai-tools` 的工具定义落地，经 MCP 暴露给外部 agent；应用内不存在模型直连与密钥；样式颜色可以引用 Token（`fillToken`/`strokeToken`，优先）也可以给字面量（`fill`/`stroke`）——新文件不预置 Token，设计系统由用户自建（ADR-0024）
7. 渲染只经 `RenderBackend` 接口；例外是 `CanvasView.vue` 里的选中框/拖拽预览叠加层（UI 局部）
8. 坐标相对父容器内容区左上角；旋转绕自身中心
9. 页面 = `DocState.rootIds` 中的 `page` 节点；"当前页面"是 UI 状态（`ui.activePageId`），不是命令的一部分
10. 渲染进程是纯 Web 页面：拿不到 Node、拿不到任意 IPC。主进程能力只能经 `preload` 的白名单对象暴露，且只在 `src/main` 落地
11. 文档真源在渲染进程：主进程不持有 `DocState`，需要读写文档时只能通过白名单 IPC 请求渲染层执行命令
12. 一次 MCP 工具调用 = 一个撤销步：执行器把该次调用的命令包进 `DocStore.transact`，用户一次撤销就能撤回整个动作

## 术语与文档

- `GLOSSARY.md` 是术语唯一真源（Frame=画板、Group=分组、命令、Token、变体=枚举型组件属性…）。不要引入同义词
- 架构以 `docs/architecture.md` 为准；重大决策新增 ADR（`docs/adr/`，顺序编号、短格式）
- `docs/roadmap.md` 划定范围：v1 无协作后端、无布尔运算、无富文本 runs——不要顺手实现
- 改行为时同步更新对应文档

## 日志

- **不要用 `console.log`**（`console.info/warn/error` 同理）：MCP 与主进程日志一律走 `apps/desktop/src/main/mcp/log.ts`——`logInfo` / `logWarn` / `logError` 是 MCP 流量（`[mcp]`），主进程事件用 `logApp`（`[app]`），渲染层上报用 `logRenderer`（`[renderer]`）。默认 sink 同时写终端（info/warn → stdout，error → stderr）与 `~/.sqraft/logs/sqraft.log`，格式、级别与参数摘要规则都在这一处实现
- 新增日志点时只给"事件 + 字段"（`logInfo(tag, "tools/call x ok 12ms", { args })`），格式与截断不要各拼一份
- 渲染层日志走 `renderer/log.ts` 的 `logInfo` / `logWarn` / `logError`，经白名单 IPC `app:log` 发"事件 + 字段"；它拿不到文件系统，字段必须是可结构化克隆的纯值（别传 Vue 代理、DOM、节点对象）。日志失败一律吞掉，不能影响业务
- 历史遗留：`main/ipc.ts` 与 `renderer/file-session.ts` 里各有 dev 专用的 `[close]` `console.info`（关闭流程诊断）；不要照抄这种写法，改到那儿时顺手迁走
- 落盘位置 `~/.sqraft/logs/`，按大小轮转：单文件 10MB、最多 10 个文件（含当前文件，归档为 `sqraft.log.1` … `.9`），启动时清掉超量；写失败静默降级为仅终端（`main/log-file.ts`）
- 参数只记摘要（长字符串截断、`data:image` 折叠成体积）。打包版从 Finder 启动时 stdout 没有出口，看日志文件，或用帮助菜单的「打开日志目录」
- 测试里用 `setMcpLogSink()` 换掉写入口（静音或断言），不要为了日志去改生产签名

## 已知坑

- `<canvas>` 除 `inset:0` 外必须显式 `width/height:100%`，否则内在像素尺寸会撑破布局（`CanvasView.vue` 修过一次）
- `pnpm build` 的类型检查**不覆盖 `.vue`**（纯 `tsc` 不解析 SFC）：`CanvasView.vue` 等文件里写错/漏定义的符号只有运行时才炸（`hitRotateZone` 就这么让画布手势全废过）。改渲染层 .vue 后至少手点一遍；补 `vue-tsc` 是 `.scratch/desktop/issues/13` 那一票
- `.sqraft` = zip（`manifest.json` + `doc.json` + `ops.ndjson`）；当前 `ops.ndjson` 恒为空（骨架阶段，增量日志未接）
- `newId()` 基于时间戳+计数器，只用于"新建节点前"，不要在命令执行期调用
- `apps/desktop/out/` 是 electron-vite 的产物（main / preload / renderer 三份），不要手改；改源码后要重新构建才会进 App
- `sandbox: true` 下 preload 只能用 `electron` 等少数模块，不能用 Node 内置模块；需要文件/网络等能力一律回调主进程
- Electron 二进制在首次 `pnpm dev` 时才下载（`electron` 包没有 postinstall），首次启动会慢
- 打包不需要把任何可执行文件放到 asar 外（旧 CLI 已删除）；未签名构建要用 `CSC_IDENTITY_AUTO_DISCOVERY=false`
- `electron-builder.yml` 里 `npmRebuild: false` 与 `electronDist: node_modules/electron/dist` 是提速项：项目没有原生模块，且复用已解压的 Electron。加原生依赖时必须去掉 `npmRebuild: false`
- macOS 用 `hiddenInset` 标题栏：左栏顶部为红绿灯让出 58px，左上 340×46 是拖拽区（`-webkit-app-region: drag`），改布局时别把这块盖住（标题栏只留拖拽，不放控件）。当前文件名与「回欢迎页」是工具栏品牌名右侧的两个胶囊（`Toolbar.vue`）
- 数据目录：`~/.sqraft/`（偏好、最近文件、排障用的 `mcp.json`、日志目录 `logs/`），启动时由 `data-dir.ts` 从旧 `userData` 迁移一次偏好
- MCP 端点：`http://127.0.0.1:<port>/mcp`（Streamable HTTP，ADR-0026）。只绑 loopback、拒绝带 `Origin` 的请求、无 token；默认端口 7331，显式端口被占即报错，自动模式才顺延。应用必须保持运行，没有 CLI 拉起
- 菜单里**别用 `role: "close"`**：它自带 `CmdOrCtrl+W` 并直接注册，会在渲染层之前吃掉 ⌘W，而 ⌘W 是"关闭文档回欢迎页"（渲染层注册表）。关闭窗口用显式的 ⇧⌘W
- `CloseGuard` 的放行状态必须随窗口重建复位（`attach()`）：macOS 关窗后从 Dock 重开，留着的 `allow` 会让守卫永久失效、静默丢稿
- 窗口**启动铺满工作区**（`ready-to-show` 里 `setBounds(display.workArea)`）：不是 macOS 全屏模式、也不进系统「最大化」，所以手动缩放的尺寸不跨启动保留；`preferences.json` 里的 `maximized` 字段目前不参与恢复，别以为它还有用
- dev 热更新会**重新执行渲染层模块**：注册 IPC 监听必须配套 `import.meta.hot?.dispose(...)` 清理。`mcp-host.ts` 把 disposer 挂到 `globalThis` 并在安装前先摘旧监听（同一条 `tools/call` 只执行一次，否则 `create_node` 会落两个节点）；`file-session.ts` 用模块级 `disposers` 数组 + HMR dispose。漏了的话，一次关闭会被多个模块实例各弹一次"保存 / 不保存 / 取消"
- 图片资源在 `.sqraft` 的 `assets/` 里按内容哈希命名，`doc.json` 只记 `assetId`；**不要**在保存时按"当前文档引用"清理资源——撤销栈里的节点还引用着它，清掉会让"保存后撤销"变破图（ADR-0022）
- 旧 CLI 软链迁移：`setup.ts` 的 `removeStaleCliLink()` 启动时只删指向本应用旧 `bin` 的 `current` / `stale` 链接，`foreign` 一律不碰；删之前必须走 `inspectEntry()`，直接 `unlink` 有误删用户文件的先例
- MCP 操作日志同时写终端与 `~/.sqraft/logs/sqraft.log`（10MB × 10 个文件轮转），打包版从 Finder 启动也能看到；写法与截断规则见上面「日志」一节

## 验证

- 代码改动：`pnpm test && pnpm build`
- 交互改动：dev 在跑且显式开了 `SQRAFT_DEBUG_PORT` 时用调试端口做只读检查（截图 + 读 DOM，不重启实例）；dev 没在跑就只跑 `pnpm test && pnpm build`，把下面的手点清单交给用户
- 桌面能力（无自动化回归，必须手点）：欢迎页 → 新建 → 改 → 保存 → 关窗 → 重开；MCP 配好 URL → 建节点 → 截图 → 一次撤销全撤（终端里应能看到对应的 `[mcp]` 行：会话、`tools/call`、耗时）；改端口后确认旧会话断开、新地址可用；拖到副屏再拖回
- 文件相关：新建/画一个矩形 → `⌘S`（首次弹另存为）→ `⌘W`（不应直接关闭）→ 重开 App 打开该文件，内容一致；外部改动该文件后再保存应出现"覆盖 / 另存为"

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/issues/`; specs live in `docs/specs/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
