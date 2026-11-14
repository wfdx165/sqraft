# ADR-0033：Windows 打包（NSIS、未签名、手动更新）

- 状态：已采纳
- 日期：2026-11-11

## 背景

0.0.4 之前只有 macOS arm64 产物：`electron-builder.yml` 只有 `mac:` 段，`dist` 写死 `--mac --arm64`，
发版脚本只认 `-arm64.dmg` / `-arm64.zip`，`latest.json` 只有 `mac-arm64` 两个键。
Windows 用户拿不到任何包，README 也明写"不支持 Windows"。

本轮要把 Windows 纳入发布链路，同时不扩大验证面：没有签名证书、没有 CI、没有自动更新的测试能力。

## 决策

1. **只出 Windows x64 的 NSIS 安装器**。ARM64 Windows 份额低且无机器验收，先不开；portable 版不支持文件关联，也不做。
2. **per-user 安装（`perMachine: false`）+ 经典向导**：`oneClick: false`、`allowToChangeInstallationDirectory: true`。
   安装器会显示安装范围页（默认仅当前用户），需要全机器安装的用户可以自己选，但不会默认提权。
3. **不签名**：Windows 首次运行会出现 SmartScreen 提示，README 与发布说明给出「更多信息 → 仍要运行」的步骤。
   证书（OV/EV）等有真实 Windows 用户后再评估。macOS 侧已于 2026-11 改为 Developer ID 签名 + 公证
   （ADR-0034），Windows 不跟着做——两条链路各自决策。
4. **Windows 不做自动安装**：主进程只检查 `latest.json` 的版本，发现新版本把状态置为 `available`，
   界面给「前往下载」按钮打开 GitHub Releases 页面。`install.ts` 的替换脚本是 macOS 专用的
   （`/bin/sh` + `ditto` + 替换 `.app`），不复用到 Windows。
5. **`latest.json` 增加 `win-x64` 键**（Setup.exe 的地址、体积、sha256）。Windows 客户端当前只读 `version`，
   键为以后接静默安装预留；发版脚本强制要求它存在，避免"提示了却下不到"。
6. **`release/` 是唯一产物收件箱**：Windows 机器上跑 `pnpm dist`，把 `Sqraft-Setup-<version>.exe`
   拷回 `apps/desktop/release/`（或 `pnpm release --win <路径>`），mac 上的 `pnpm release` 一次性上传
   macOS 与 Windows 全部资产。缺任一平台产物即中止。
7. **Windows 构建必须在 Windows 机器上跑**。electron-builder 交叉构建 Windows 包依赖 wine，
   在 Apple Silicon 上还有已知 NSIS 失败案例；即使出包也无法安装验收。
8. **macOS 继续只出 arm64**：本轮不顺带补 Intel。`install.ts` 的 `arch !== "arm64"` 判断保持不变。
9. **窗口外壳按平台分叉**：macOS 继续 `hiddenInset`（红绿灯 + 58px 留白 + 拖拽条），
   Windows 用系统默认标题栏（`main/index.ts` 的 `isMac` 分支），应用内不留那 58px。
10. **快捷键显示按平台格式化**：内部规范串仍是 `⌘⇧Z`（`bindingOfEvent` 把 Ctrl 归一成 ⌘），
    显示层在非 mac 上输出 `Ctrl+Shift+Z`。新增 `shared/binding.ts`，主进程菜单与渲染层 tooltip/面板共用。
11. **字体不捆绑中日韩**：拉丁字母用随包分发的 Geist，CJK 用系统字体（雅黑 / Yu Gothic / Malgun Gothic）。
    代价是同一文档在不同系统上换行位置可能不同，写进 README 的限制。

## 后果

- 发版多一步：先在 Windows 上出包并手点验收，再把 exe 放进 `release/`。漏了会被脚本拦下，不会出现"只发了 mac"的版本。
- Windows 用户更新要手动去下载页；工具栏会常驻「前往下载」胶囊直到更新。
- 未签名 + SmartScreen 会劝退一部分用户，这是这个版本接受的成本。
- `verify-pack` 增加 Windows 分支：检查 `win-unpacked/resources/app.asar` 的内容与 `Sqraft.exe` 的 fuse 状态。
- macOS Intel、Linux、Windows 代码签名、Windows 静默自动升级仍是缺口，需要各自单独决策
  （macOS 签名已单独落地，见 ADR-0034）。

## 后续修订

- 2026-11-13：打包命令合并为单一的 `pnpm dist`。它按宿主平台选目标（macOS 固定
  `--mac --arm64`、Windows 固定 `--win --x64`，其余宿主直接报错），构建完统一跑
  `verify-pack`；`dist:mac` / `dist:win` 删除，也不提供 `--win` 之类的强制平台入口。
  `pnpm release` 仍是 macOS 专用的发版编排，并新增"非 darwin 立即退出"的守卫
  （避免在别的平台上先 `clean` 掉 `release/` 再失败）。
  决策 1–11 全部不变：仍不交叉构建、仍是 NSIS、仍只在 mac 上编排发版。
- 2026-11-13：macOS 包改为 Developer ID 签名 + 公证（ADR-0034）。Windows 侧不变（仍不签名、
  仍只提示更新）；`dist.mjs` / `verify-pack` 的签名断言只对 macOS 生效。
