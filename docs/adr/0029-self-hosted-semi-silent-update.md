# ADR-0029：自建半静默更新（GitHub Releases、退出时替换）

> Sqraft 要升级时必须让已装旧版的人低成本换到新版。本 ADR 记录自建更新链路的取舍：
> 更新包长什么样、谁来下载、什么时候安装、装坏了怎么退回去。
>
> 立项时项目**未签名、未公证**，因此不能直接用 `electron-updater`（macOS 上它走 Squirrel.Mac，
> 启动就校验代码签名）。2026-11 起 macOS 包已改为 Developer ID 签名并公证（ADR-0034），
> 签名不再是阻塞；但这条链路已经验过替换与回滚，**暂不迁移**，迁移留给独立一票。

## Context

- 项目早期只分发给作者与少量用户，没有灰度、没有下载站；发布就是本机 `pnpm dist` 出一个 dmg。
- macOS 上 `autoUpdater` / Squirrel.Mac 要求有效代码签名，未签名直接报
  `Could not get code signature for running application`；买 Apple Developer Program 属于另一票
  （2026-11 已完成，见 ADR-0034）。
- dmg 是只读挂载，无法原地替换 `.app`；自动更新必须用 zip。
- 未签名应用从浏览器下载会被打上隔离标记（quarantine），首次打开要右键 → 打开；
  而由**应用自己**用 Node 下载的文件不带这个标记（签名 + 公证后这条依然成立，只是首启不再被拦）。
- macOS 关窗不退出（`⌘W` 是回欢迎页），用户可能连续几天不退出；"只在退出时安装"会显著延迟生效。
- 应用有 `CloseGuard`：退出前要问"保存 / 不保存 / 取消"，更新不能绕过它。
- `.sqraft` 的 `manifest.json` 已经带 `formatVersion`；升级后必然出现新 app 读旧文件、旧 app 读新文件。
- 没有可用的崩溃上报；装坏一个新版本等于让对方就地卡死，而对方不是开发者。

## Decision

**发布侧**

- 版本号唯一真源是 `apps/desktop/package.json`（`0.x` 语义化，手动修改）；根 `package.json`
  不带 `version`。客户端用 `app.getVersion()`，dmg/zip 名、`latest.json`、关于面板都取这一个值。
- 源码、安装包与下载页在同一个公开 GitHub 仓库（2026-11 起以 Apache-2.0 开源）：
  `pnpm release` 只面向这个仓库，不检查本地分支、工作区或 tag，`latest.json` 也不记录 commit；
  `vX` tag 由 `gh release create` 创建，同时充当源码的版本标记。
- 产物是 **dmg + zip**：dmg 给手动安装，zip 给自动替换（`electron-builder.yml` 两个 target）。
- Windows 出 x64 的 NSIS 安装器（ADR-0033）。客户端**只提示、不安装**：`latest.json` 的
  `win-x64` 键为以后接静默安装预留，当前只读 `version`；安装器由用户自己下载执行。
- `pnpm release`（`scripts/release.mjs`）一条命令：打包 → 算 sha256 → 生成 `latest.json` →
  `gh release create`。默认 **draft**（用来核对 notes 与资产），`--publish` 直接发。
- **draft 阶段验证不了自动更新**：`/releases/latest` 不含 draft，draft 资产匿名下载也是 404。
  正确流程是"发布 → 从上一版点「检查更新…」验证 → 坏了靠回滚 + 发补丁版"。
- 替换 / 回滚不依赖网络，用 `pnpm stage:update` 本地演练：把本地产物放进
  `userData/updates/update.zip` 并标记 `readyVersion`，启动后点「重启更新」即可。
- 发布仓库写在 `apps/desktop/update.config.json`，客户端与脚本读同一份。
- 客户端固定拉
  `https://github.com/<repo>/releases/latest/download/latest.json`（GitHub 的重定向，不用 API、不限流、不要 token）。
- 更新说明从 `docs/releases/vX.Y.Z.md` 读；没有就不带说明。不做 beta 通道。

**客户端侧**

- **半静默**：`ready-to-show` 后延迟 5 秒检查，24 小时节流；失败静默只写日志。
  帮助菜单「检查更新…」是手动入口，不受节流，失败原因留在关于面板。
- 有新版本 → 后台下载 zip 到 `userData/updates/update.zip`，边下边算 sha256，校验通过才改名。
- 进入"已就绪"后，工具栏出现「重启更新」胶囊；**退出时**替换并重启（`will-quit` 里同步启动 detached 脚本）。
- 就绪满 7 天在启动时用系统对话框提醒一次（同一版本只提醒一次），**永不强制重启**。
  不做"跳过此版本"。
- **替换**：`/bin/sh` 脚本等主进程退出 → 旧 `.app` 改名为 `.backup` → `ditto -x -k` 解包落位 →
  `open` 新版本 → 等启动标记（60 秒）→ 写失败回执、删除坏包并换回备份、重新启动旧版。
  启动标记由新版本在 `initUpdater()` 一开始写入。
- **Windows 只提示**：`resolveInstallSupport` 对 win32 返回 `notify`——检查版本后状态置为
  `available`，工具栏给「前往下载」打开 Releases 页面；不下载、不替换、不回滚（ADR-0033）。
  安装器是 per-user 的 NSIS，卸载保留 `%APPDATA%\Sqraft`。
- **前置检查**：非打包 / 非 darwin（Windows 走 `notify`）/ 非 arm64 / 从 dmg 挂载点或 AppTranslocation 运行 / 目录不可写，
  一律提前拒绝并说明原因（不下载、不占用磁盘）。
- **信任**：只接受 https + `github.com` 与 `*.githubusercontent.com`；下载时手动跟随重定向、
  每一跳都过白名单；sha256 不匹配即丢弃。`latest.json` 不做签名。
  签名 + 公证之后（ADR-0034）身份可校验了：替换脚本在挪走旧包**之前**跑
  `codesign --verify --deep --strict` 并把新包的 Team 与"当前正在运行那一版"的 Team 比对，
  不一致或验签失败就保留旧版本（旧版本未签名时该段跳过，用于 0.0.4 → 签名首发的过渡）。
  `EnableEmbeddedAsarIntegrityValidation` 仍不启用（本轮决定见 ADR-0034），构建期防护的上限见 ADR-0030。
- **UI**：工具栏胶囊（仅"已就绪"时存在）、帮助菜单「检查更新…」、关于面板（版本 / 状态 / 检查按钮 / 说明）。
- **重启**走 `app.quit()`，由既有 `CloseGuard` 询问是否保存；用户取消则保持"已就绪"。
- **格式版本硬门槛**：读取时 `formatVersion > CURRENT_FORMAT_VERSION` 明确拒绝并提示升级；
  迁移仍在渲染层顺序执行。`manifest.version` 写真实应用版本（不再是常量 `0.0.1`）。
- **MCP**：新增只读 `app_info`（应用名 / 版本 / 格式版本 / 平台），不提供 `check_update` /
  `install_update`——agent 不能改用户的安装状态。

## Considered Options

- **`electron-updater` + Squirrel.Mac**：维护成本最低，但要求代码签名；立项时未签名、更新直接失败。否决。
  （2026-11 签名已落地，迁移仍推迟：现有链路验过替换与回滚，迁移属于独立一票。）
- **买了开发者账号再上自动更新**：能拿到静默安装与公证，但工作量（证书、公证、CI）比更新本身还大，
  且只有真正对外分发才值得。推迟。
- **只提示 + 打开 GitHub 页面**：代码最少，但浏览器下载会带隔离标记，用户大概率卡在
  "无法验证开发者"；且要多走一次浏览器。本方案保留 app 内下载正是为了绕开这一点。
- **完全静默（后台替换 + 自动重启）**：会替用户决定丢弃未保存修改，与 `CloseGuard` 冲突。否决。
- **用 dmg 做自动更新**：只读挂载无法原地替换。否决。
- **`latest.json` 加 ed25519 签名**：能防仓库被拿下后替换资产，但当前威胁模型（公开仓、无金钱价值）
  下收益有限；与代码签名一起做更顺。推迟（代码签名已于 2026-11 落地，见 ADR-0034；`latest.json` 签名仍未做）。
- **beta 通道 + 跳过版本**：给大规模分发准备的状态机，两三个用户不需要。否决。
- **发布前用 draft 完整验证自动更新**：`/releases/latest` 只有已发布版本，draft 资产匿名不可下载，
  除非引入 token（与"下载不留凭据"冲突）或第二条 feed（与"不做 beta 通道"冲突）。不可行，
  改为 `stage:update` 本地演练替换链路、发布后验证检查链路。

## Consequences

- 现在这批 `0.0.1` 用户（含开发者本人）必须**手动装一次**首个带更新器的版本（`0.0.2`），之后才进链路。
- macOS 包自 2026-11 起为 Developer ID 签名 + 公证（ADR-0034）：首次安装不再需要右键 / `xattr` 放行；
  但**从旧版本自动更新上来的那一次**仍由旧版（未签名）执行替换，提示与否取决于用户装的是哪一版。
- 应用必须从可写位置（推荐 `/Applications`）运行；从 dmg 里直接开会被前置检查拒绝。
- 更新链路的网络、解包、替换全在主进程；渲染层只显示状态、触发重启，不碰文件系统（ADR-0019 不变式）。
- 更新失败会回滚、删除坏包、清掉"已就绪"并记下 `failedVersion`（自动检查不再重下同一版本）；
  日志留在 `updates/install.log`，备份在启动成功后删除。
- 首次发布前必须把 `update.config.json` 改成真实仓库，否则检查是 404（表现为静默不更新）。
- 7 天提醒与回滚都只覆盖"能启动"的场景；新版本在启动后崩溃仍要靠用户手动打开备份。
  这是无遥测前提下的已知上限（签名只解决"包有没有被改"，不解决"新版本自己崩"）。
- 自动更新的"检查 → 下载"只能在发布后验证；发布前能验证的是替换、备份、回滚（`stage:update`）。

## 后续修订

- 2026-11-13：macOS 包改为 Developer ID 签名 + 公证（ADR-0034）。标题与前提里的"未签名"不再成立；
  更新链路的检查 / 下载 / 回滚不变，替换脚本新增"落位前验签 + Team 比对"；
  `EnableEmbeddedAsarIntegrityValidation` 仍另开票评估。
