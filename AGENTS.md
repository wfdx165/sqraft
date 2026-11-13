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
- 打包：`pnpm dist` —— 按宿主平台出包：macOS 出 arm64 的 dmg 与 zip（zip 供自动更新），Windows 出 x64 的 NSIS 安装器（ADR-0033）；**不支持交叉构建**，Windows 包必须在 Windows 机器上跑，其它宿主（Linux / 容器）直接报错。mac 固定 `--mac --arm64`、Windows 固定 `--win --x64`，不提供指定平台的口子。产物都在 `apps/desktop/release/`；不生成 sourcemap（ADR-0030）
- 桌面包的 `dist` / `dist:dir` 都先跑 `pnpm clean`：清空 `apps/desktop/out/` 与 `release/`，避免旧产物被打进 asar 或堆在 release 里；想保留上一次的 dmg 用 `pnpm --filter @sqraft/desktop exec node scripts/clean.mjs --keep-release`
- 快速出包（只出 `.app` / `win-unpacked`、不建 dmg 或安装器，约 4s）：`pnpm dist:dir` —— 验证"打包后能不能跑 / MCP 通不通"用它
- 成品防护验收：`pnpm --filter @sqraft/desktop run verify:pack [产物路径]` —— 断言 asar 里只有 `out/**` 与 `package.json`、没有源码 / map / `node_modules`、渲染层已压缩、fuse 已翻转（ADR-0030）；默认按平台挑 `release/mac-arm64/Sqraft.app` 或 `release/win-unpacked`。`pnpm release` 与 `pnpm dist` 末尾都会自动跑当前平台那一侧
- 发版：`pnpm release`（draft；出包前要求发布说明存在 + `pnpm test` 通过，不检查本地 git 状态）/ `pnpm publish:release`（翻正式）/ `pnpm publish:readme`（同步四语言下载页）；版本号手动改 `apps/desktop/package.json`（唯一真源，脚本只读、不接受版本参数），日常只升 patch，完整流程见 `docs/releasing.md`
- 界面文案：一律走 `t()`（渲染层 `renderer/i18n.ts`、主进程 `main/i18n.ts`）；新键同时补 `src/shared/i18n/` 下的 `zh-CN.ts`、`en-US.ts`、`ja-JP.ts`、`ko-KR.ts`（四份类型强制对齐），模板里写死中文会被 `i18n.test.ts` 拦下
- 界面语言：`auto` / `zh-CN` / `en-US` / `ja-JP` / `ko-KR`；`auto` 按系统 `zh*` / `ja*` / `ko*` 匹配，其余回退英文。字体栈与日文禁则的约定见 ADR-0031 与 `GLOSSARY.md`；已有文档的 `fontFamily` 不改
- MCP 面向 agent 的错误固定英文（`shared/agent-text.ts` + `agentErrorText()`），不要放进 UI 字典；只有端口/监听这类进设置面板的错误才走 `t()`
- 菜单：MCP 入口在 macOS 应用菜单「设置…」旁边，非 mac 放进「文件」菜单；帮助菜单不再放 MCP
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
  5. 若 Electron 升级：更新本文件「版本锁定」里的 Chromium 版本行。

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
- `README.md` 是对外下载页（同步到公开发行仓库）：只写产品、安装、能力与限制，**不放构建命令与架构细节**；开发手册就是本文件。对外 README 有四份（英文首屏 + 中 / 日 / 韩），改一份必须同步其余三份，`pnpm publish:readme` 会校验
- 改行为时同步更新对应文档

## 日志

- **不要用 `console.log`**（`console.info/warn/error` 同理）：MCP 与主进程日志一律走 `apps/desktop/src/main/mcp/log.ts`——`logInfo` / `logWarn` / `logError` 是 MCP 流量（`[mcp]`），主进程事件用 `logApp`（`[app]`），渲染层上报用 `logRenderer`（`[renderer]`）。默认 sink 同时写终端（info/warn → stdout，error → stderr）与平台日志目录 `app.getPath("logs")/sqraft.log`（macOS 即 `~/Library/Logs/Sqraft/`），格式、级别与参数摘要规则都在这一处实现
- 新增日志点时只给"事件 + 字段"（`logInfo(tag, "tools/call x ok 12ms", { args })`），格式与截断不要各拼一份
- 渲染层日志走 `renderer/log.ts` 的 `logInfo` / `logWarn` / `logError`，经白名单 IPC `app:log` 发"事件 + 字段"；它拿不到文件系统，字段必须是可结构化克隆的纯值（别传 Vue 代理、DOM、节点对象）。日志失败一律吞掉，不能影响业务
- 历史遗留：`main/ipc.ts` 与 `renderer/file-session.ts` 里各有 dev 专用的 `[close]` `console.info`（关闭流程诊断）；不要照抄这种写法，改到那儿时顺手迁走
- 落盘位置 `app.getPath("logs")/`（macOS `~/Library/Logs/Sqraft/`），按大小轮转：单文件 10MB、最多 10 个文件（含当前文件，归档为 `sqraft.log.1` … `.9`），启动时清掉超量；写失败静默降级为仅终端（`main/log-file.ts`）
- 参数只记摘要（长字符串截断、`data:image` 折叠成体积）。打包版从 Finder 启动时 stdout 没有出口，看日志文件，或用帮助菜单的「打开日志目录」
- 测试里用 `setMcpLogSink()` 换掉写入口（静音或断言），不要为了日志去改生产签名

## 已知坑

- `<canvas>` 除 `inset:0` 外必须显式 `width/height:100%`，否则内在像素尺寸会撑破布局（`CanvasView.vue` 修过一次）
- `pnpm build` 的类型检查**不覆盖 `.vue`**（纯 `tsc` 不解析 SFC）：`CanvasView.vue` 等文件里写错/漏定义的符号只有运行时才炸（`hitRotateZone` 就这么让画布手势全废过）。改渲染层 .vue 后至少手点一遍；补 `vue-tsc` 是 `.scratch/desktop/issues/13` 那一票
- `.sqraft` = zip（`manifest.json` + `doc.json` + `ops.ndjson`）；当前 `ops.ndjson` 恒为空（骨架阶段，增量日志未接）
- `newId()` 基于时间戳+计数器，只用于"新建节点前"，不要在命令执行期调用
- `apps/desktop/out/` 是 electron-vite 的产物（main / preload / renderer 三份），不要手改；改源码后要重新构建才会进 App
- `sandbox: true` 下 preload 只能用 `electron` 等少数模块，不能用 Node 内置模块；需要文件/网络等能力一律回调主进程
- 打包版 CSP 是 `script-src 'self'`，**没有放行 `blob:`**：任何会用 blob-URL Web Worker 的库（如 fflate 的 async API）在打包版会被拦——worker 不报错也不回调，promise 永久挂起，症状是"保存没反应、窗口关不掉"（保存改用 `zipSync`，与读路径 `unzipSync` 对称；引入新依赖时避开这类 async API，或给 CSP 补 `worker-src`）
- Electron 二进制在首次 `pnpm dev` 时才下载（`electron` 包没有 postinstall），首次启动会慢
- 打包不需要把任何可执行文件放到 asar 外（旧 CLI 已删除）；未签名构建要用 `CSC_IDENTITY_AUTO_DISCOVERY=false`
- `electron-builder.yml` 里 `npmRebuild: false` 与 `electronDist: node_modules/electron/dist` 是提速项：项目没有原生模块，且复用已解压的 Electron。加原生依赖时必须去掉 `npmRebuild: false`
- **`apps/desktop/package.json` 的 `dependencies` 必须是空的**（ADR-0030）：三个 `@sqraft/*`、`vue`、fontsource、`fflate` 全由 Vite 在构建期 bundle 进 `out/`，主进程与 preload 运行时只 require `electron` + Node 内置模块。一旦把某个包写回 `dependencies`，electron-builder 会把整棵依赖树（含源码与 `.map`）复制进 asar，`verify:pack` 与 `pnpm release` 的预检都会拦下
- 成品 `app.asar` 里只允许出现 `out/**` 与 `package.json`：`minify` 被关掉、或 `files` 里漏了 `!out/**/*.map`，都会以"包里又有了可读源码"的形式复发。改构建配置后跑一次 `pnpm --filter @sqraft/desktop run verify:pack`
- 版本号唯一真源是 `apps/desktop/package.json`；根 `package.json` 故意不带 `version`。`pnpm release` 只读版本、不接受 `--bump` / `--version`，出包前要求发布说明存在 + 测试通过，但不检查本地 git 状态（ADR-0029 / ADR-0030）
- 发版只要求「版本号 + 发布说明 + GitHub 凭证」：`docs/releases/vX.md` 必须存在且非空，缺失即中止；`pnpm release` 不检查本地分支、工作区或 tag，发行仓的同名 tag 由 `gh release create` 创建
- 界面语言的初始值由 `main.ts` 在挂载前从 `app.info()` 取（主进程解析 `auto`）；不要在渲染层用 `navigator.language` 自己判断，否则菜单与页面会不一致
- `@electron/fuses` 开了 `strictlyRequireAllFuses`：Electron 升级新增 fuse 时构建会失败（Electron 45 已有 9 个），升级时要先读新版 fuse 列表再补配置，不要把它关掉
- 打包版用不了 `--inspect`、`ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`：fuse 已关（ADR-0030）。排障只能靠日志（`~/Library/Logs/Sqraft/`）与渲染层上报
- 打包版与 `/Applications` 里的已装版本共用同一个 `userData` 单实例锁，且 `main/index.ts` 会 `app.setPath("userData", …)` 覆盖 `--user-data-dir`：用户开着 Sqraft 时，另起一个 `.app` 会拿不到锁、立刻 `exit 0`。这不是 fuse 或签名坏了，别误判
- macOS 用 `hiddenInset` 标题栏：左栏顶部为红绿灯让出 58px，左上 340×46 是拖拽区（`-webkit-app-region: drag`），改布局时别把这块盖住（标题栏只留拖拽，不放控件）。当前文件名与「回欢迎页」是工具栏品牌名右侧的两个胶囊（`Toolbar.vue`）
- Windows 用系统默认标题栏（`main/index.ts` 的 `isMac` 分支），`App.vue` 只对 `data-platform="darwin"` 加 58px 留白与拖拽条；别把这两条规则改成全局，否则 Windows 顶部会凭空多出一条空白。Windows / Linux 的菜单栏**常显**（`autoHideMenuBar: false`）：改成隐藏后只有 Alt 能唤起，「打开日志目录」「清空图片缓存」这些入口等于找不到
- 键位显示必须走 `formatBinding()`（`shared/binding.ts`）：内部存储是 `⌘⇧Z` 规范串，Windows 显示 `Ctrl+Shift+Z`。渲染层用 `keyLabel(id)`，主进程菜单在 `actionItem()` 里格式化；直接把 `keyOf()` 拼进 Windows 菜单或 tooltip 会显示 ⌘
- Windows 包只能在 Windows 上构建（`pnpm dist` 在 Windows 宿主上出 exe）：mac 交叉编译要装 wine，Apple Silicon 上有 NSIS 失败案例，且出包后没法验收。`apps/desktop/release/` 是唯一产物收件箱，`pnpm release` 缺 `Sqraft-Setup-<version>.exe` 会直接中止（ADR-0033）
- `pnpm dist` 会先 `pnpm clean` 清空 `release/`：不要把已构建的 exe 提前放进去再跑 `dist`。`pnpm release` 会先确认 Windows 包存在并挪到临时目录，再构建 macOS（clean 不会吃掉它），所以「拷进 release/ 再 release」与 `--win <路径>` 两种顺序都安全；只有 `--skip-build` 时才需要 mac 产物本来就在 release/ 里。`pnpm release` 只在 macOS 上跑，其它平台会在任何 clean 之前直接退出
- Windows 未签名：首次运行会弹 SmartScreen，发布说明与 README 要给「更多信息 → 仍要运行」的步骤；`win-x64` 在 `latest.json` 里只用于以后接静默安装，客户端当前只读 `version`
- `build/icon.ico` 由 `build/icon.png` 生成（16–256 多尺寸 PNG 条目），改图标要同时更新 `.icns` 与 `.ico`
- NSIS 配置是 `perMachine: false` + `oneClick: false`：安装器会显示安装范围页（默认仅当前用户），不是"静默装到用户目录"。electron-builder 的向导**没有**"创建桌面快捷方式"勾选项：`createDesktopShortcut: true` 就是安装时直接建，用户删掉后重装不会强制重建（别改成 `"always"`）
- 数据目录：平台惯例的 `userData`（macOS `~/Library/Application Support/Sqraft`，Windows `%APPDATA%\Sqraft`），dev 与打包版共用；里面是偏好、最近文件、排障用的 `mcp.json`、链接图缓存 `image-cache/`。日志单独走 `app.getPath("logs")`（macOS `~/Library/Logs/Sqraft/`）。首次启动由 `data-dir.ts` 同步把旧的 `~/.sqraft` 一次性迁过来（**可再生的浏览器缓存与 socket 残留留在旧目录不动**，失败不阻断启动）
- MCP 端点：`http://127.0.0.1:<port>/mcp`（Streamable HTTP，ADR-0026）。只绑 loopback、拒绝带 `Origin` 的请求、无 token；默认端口 7331，显式端口被占即报错，自动模式才顺延。应用必须保持运行，没有 CLI 拉起
- 菜单里**别用 `role: "close"`**：它自带 `CmdOrCtrl+W` 并直接注册，会在渲染层之前吃掉 ⌘W，而 ⌘W 是"关闭文档回欢迎页"（渲染层注册表）。关闭窗口用显式的 ⇧⌘W
- `CloseGuard` 的放行状态必须随窗口重建复位（`attach()`）：macOS 关窗后从 Dock 重开，留着的 `allow` 会让守卫永久失效、静默丢稿
- 窗口**启动铺满工作区**（`ready-to-show` 里 `setBounds(display.workArea)`）：不是 macOS 全屏模式、也不进系统「最大化」，所以手动缩放的尺寸不跨启动保留；`preferences.json` 里的 `maximized` 字段目前不参与恢复，别以为它还有用
- dev 热更新会**重新执行渲染层模块**：注册 IPC 监听必须配套 `import.meta.hot?.dispose(...)` 清理。`mcp-host.ts` 把 disposer 挂到 `globalThis` 并在安装前先摘旧监听（同一条 `tools/call` 只执行一次，否则 `create_node` 会落两个节点）；`file-session.ts` 用模块级 `disposers` 数组 + HMR dispose。漏了的话，一次关闭会被多个模块实例各弹一次"保存 / 不保存 / 取消"
- 图片资源在 `.sqraft` 的 `assets/` 里按内容哈希命名，`doc.json` 只记 `assetId`；**不要**在保存时按"当前文档引用"清理资源——撤销栈里的节点还引用着它，清掉会让"保存后撤销"变破图（ADR-0022）
- 旧 CLI 软链迁移：`setup.ts` 的 `removeStaleCliLink()` 启动时只删指向本应用旧 `bin` 的 `current` / `stale` 链接，`foreign` 一律不碰；删之前必须走 `inspectEntry()`，直接 `unlink` 有误删用户文件的先例
- 数据目录迁移的过渡期：旧版本仍写 `~/.sqraft`、新版本写 `~/Library/Application Support/Sqraft`，**两者单实例锁不在同一个 userData，可以同时运行并写同一个 `.sqraft`**。升级后先退掉所有旧实例再启动新包
- 链接图缓存目录叫 `image-cache`，**不能叫 `cache`**：Chromium 的 HTTP 缓存在 `userData/Cache`，大小写不敏感卷上会撞成同一目录（早期实现踩过，`data-dir.ts` 的 `relocateImageCache()` 负责把误放进去的图片搬出来）
- MCP 操作日志同时写终端与 `app.getPath("logs")/sqraft.log`（macOS `~/Library/Logs/Sqraft/`，10MB × 10 个文件轮转），打包版从 Finder 启动也能看到；写法与截断规则见上面「日志」一节

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
