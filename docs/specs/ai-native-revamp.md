# ai-native-revamp：AI 原生门面重塑（共识记录）

来源：2026-11-02 与用户逐题拍板（grilling，13 轮）。本文是这批工作的唯一共识记录；实现票在 `.scratch/ai-native-revamp/issues/`。

## 三个目标

1. **把"AI 驱动"从文案变成体验**：接入即成（一键配好客户端）+ 改动可审查（agent 时间线与分级撤销）
2. **运行时与产物不主动暴露 Electron**（S2 档），但**保留许可文本**（合规下限：Electron MIT 要求分发时保留版权声明）
3. **数据目录归 macOS 惯例**：`~/Library/Application Support/Sqraft`，`~/.sqraft` 不复存在

## 决定（编号 = 拍板轮次）

### 一、AI 理念的落点

- **Q1 落点**：做 L2（接入体验）+ L3（可审查）；L1 只补文档一致性；**L4 应用内对话/生成不做**——不推翻 ADR-0004 单插槽，不把产品拖回"内置聊天壳"
- **Q8 L2 形态 = B**：检测已安装客户端 → 直接写用户级配置。四条硬护栏：
  1. 只写用户级配置（`~/.claude.json`、`~/.cursor/mcp.json`、`~/.config/opencode/opencode.json`），绝不碰项目目录
  2. 每次写前备份到同目录 `*.sqraft-backup-<时间戳>`，先写临时文件再 rename，失败原文一字节不动
  3. 只增删自己的 key；解析失败（如 JSONC 带注释）直接降级为剪贴板 + 明确提示，不强行重写
  4. 每个客户端一次显式点击，不静默批量写；写完提示"重启客户端生效"
  - 检测方式：查已知配置文件 + `/Applications` 应用包，不扫 PATH
- **Q11 端口漂移 = T1 + 降级**：记录"写过哪些客户端配置"，端口变化时用同一套护栏自动重写自己的 key，toast 告知；写不动退化为显式"重新写入"按钮。不选"钉死端口"（换来的是服务起不来，更差）
- **Q9 L3 撤销 = R2 分级撤销**：`DocStore` 撤销栈是线性的（`store.ts:111-116`，新编辑清空 redo），"撤中间一步、保留之后"当前做不到。所以：最后一条 → 一键撤；中间条目 → 「回到这一步」并列出**连带撤销 N 步（其中 M 步是你的手动编辑）**+ 二次确认。**不做分支撤销**（R3 要改栈模型，v1 范围外）
- **Q10 时间线 = P1 会话内存**：只存本次打开期间，不落盘。`ops.ndjson` 接线牵动打开重放语义与文件隐私（客户端身份会随 `.sqraft` 走），**另立一票**，不与时间线绑定

### 二、Electron 隐身

- **Q2 范围 = S2**：不改仓库文档与 commit（S3 成本高收益零），目标是"普通用户不会注意到"，不是"技术人员查不出来"（`Electron Framework.framework` 必然在包里）
- **Q7 落地表**（六行全收）：

| 项 | 做法 |
|---|---|
| 抓链接图的 UA | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.49 Safari/537.36 Sqraft/0.0.1`——去掉 Electron 词、保留浏览器底味防 CDN 拦截 |
| Info.plist 权限文案 | 删掉 Electron 默认注入的摄像头/麦克风/蓝牙等 7 条（应用对权限请求一律拒绝，`main/index.ts:209-210`），`afterPack` patch（签名之前，会被正常重签） |
| helper 进程名 | `CFBundleName` `Electron Helper (Renderer)` → `Sqraft Helper (Renderer)` 等四个，同在 `afterPack` patch |
| asar 内 description | "Electron 壳 + 渲染层" → "Sqraft 桌面应用（纯单机、桌面优先）" |
| 日志首行字段 | `electron=… chrome=…` → `runtime=… engine=…`（版本值必须留，排障刚需） |
| 开源许可 | 「关于」面板新增「开源许可」：Electron LICENSE + LICENSES.chromium.html + 主要依赖（Vue / fflate 等）。**不弹窗、不主动展示**，只保证存在 |

### 三、数据目录

- **Q3 走严格惯例（P2）**：应用数据与 Chromium profile 全归 `~/Library/Application Support/Sqraft`，与 VS Code / Slack 一致；`~/.sqraft` 消失。理由：`~/Library` 在 macOS 是隐藏目录，比家目录点目录更难被普通用户撞见，也更符合 Q2 的 S2 目标
- **Q5 残留处置 = M2**：四样应用数据 + 活跃 profile 搬过去后，`~/.sqraft` 剩余浏览器残留**原地不管**（不删、不留说明）
- **Q6 dev 与打包版共用**同一数据目录（现状即共用，改了不换来什么；单实例锁已保证不并存）
- **Q15 日志单独走平台日志目录**（`app.getPath("logs")`，macOS `~/Library/Logs/Sqraft/`）：诊断产物不跟用户数据混放，Console.app 能直接列出；轮转上限不变（单文件 10MB、共 10 个文件）；迁移时旧 `~/.sqraft/logs` 一并搬过去
- 迁移顺序敏感（APFS 大小写不敏感，旧链接图缓存住在 Chromium 的 `Cache/images`，必须先抽出来；应用缓存最终落在不撞名的 `userData/image-cache/`）：
  1. 抽出 `Cache/images`（应用数据）
  2. 清 Library 侧旧 profile 残留与孤儿 `preferences.json`（两份 profile 直接合并会撞 Cookies journal）
  3. 搬活跃 profile——**Local Storage 里有自定义快捷键与标尺/网格/吸附开关**，必须搬不能删
  4. 搬 `preferences.json` / `logs/` / `mcp.json` / `Cache/images` → `image-cache/`
  5. 收尾不管残留

### 四、执行

- **Q4 文档一致性现在补**：ADR-0004（12 工具 → 现状描述、字面量色值策略）、GLOSSARY + roadmap 的"本机 IPC" → Streamable HTTP、ADR-0008 标 superseded、3 处过时代码注释
- **Q12 排期 A → B → C → D → E**（见下表），每批门槛 `pnpm test && pnpm build`；C 与 E 改打包行为，额外出 `.app` 手点（`--keep-release`，不碰现有 dmg）
- **Q13 落票 = K1**：按仓库 issue tracker 惯例分票记录

## 批次与票

| 批 | 内容 | 票 |
|---|---|---|
| A | 文档一致性 | `issues/01-docs-consistency.md` |
| B | 保存链路竞态收尾（跨 feature） | `.scratch/logging/issues/02-save-race-fixes.md` |
| C | S2 隐身 + 数据目录迁移（合并一次出包、一次手点） | `issues/02-runtime-obscurity.md`、`issues/03-data-dir-migration.md` |
| D | agent 时间线 + 分级撤销 | `issues/04-agent-timeline.md` |
| E | 一键接入 MCP 客户端 | `issues/05-one-click-mcp-setup.md` |

## 明确不做

- L4：应用内对话/生成入口、模型直连、API Key 输入
- 分支撤销（改 `DocStore` 栈模型）
- 时间线持久化 / `ops.ndjson` 接线（另立一票）
- S3：仓库文档、commit 里抹掉 Electron
- 完全不可探测（Electron Framework 二进制必然在包内）
