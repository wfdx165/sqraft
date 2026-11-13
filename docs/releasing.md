# 发版手册

Sqraft 发布 **macOS arm64** 与 **Windows x64** 两个平台的安装包：
源码、安装包与下载页都在同一个公开仓库 [`wfdx165/sqraft`](https://github.com/wfdx165/sqraft)。
macOS 的自动更新靠该仓库的 `releases/latest/download/latest.json`（ADR-0029）；
Windows 只做「检查并提示」，更新靠手动下载安装器（ADR-0033）。
macOS 包自 2026-11 起用 **Developer ID Application 签名 + 公证**（ADR-0034），
发版机必须有证书、Xcode（`notarytool`）与公证凭据；Windows 包仍未签名。

> 发行仓库必须保持 **public**。私有仓库 = `latest.json` 404 = 自动更新静默失效。

## 一次性准备

```bash
brew install gh
gh auth login          # GitHub.com → HTTPS → 浏览器授权
gh auth status         # 确认账号对 wfdx165/sqraft 有写权限
```

`gh auth login` 是整条链路上唯一必须人工完成的步骤。

### macOS 签名与公证（一次性）

发版机（目前是作者本机）需要三样东西，缺一样 `pnpm dist` 会在构建前就报错退出：

1. **Developer ID Application 证书**（不是 `Apple Development`）：
   Xcode → Settings → Accounts → 选团队 → Manage Certificates… → `+` → Developer ID Application。
   验收：`security find-identity -v -p codesigning` 里能看到 `Developer ID Application: … (TEAMID)`。
2. **Xcode**（不是只有 Command Line Tools）：公证要用 `xcrun notarytool`。
   验收：`xcrun --find notarytool` 有输出。
3. **公证凭据**：推荐 App Store Connect → Users and Access → Integrations → App Store Connect API
   → Team Keys → `+`（角色 Developer），下载 `.p8`（只给一次）并记下 Key ID 与 Issuer ID。
   ```bash
   mkdir -p ~/.config/sqraft && install -m 600 ~/Downloads/AuthKey_XXXXXXXXXX.p8 ~/.config/sqraft/
   ```
   然后写进 shell profile（`.p8` 与密钥**不进仓库、不进 CI**）：
   ```bash
   export APPLE_API_KEY="$HOME/.config/sqraft/AuthKey_XXXXXXXXXX.p8"
   export APPLE_API_KEY_ID="XXXXXXXXXX"
   export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   ```
   验收（只读，不产生公证提交）：
   ```bash
   xcrun notarytool history --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
   ```
   返回 `No submission history.` 或历史列表即通过；`401` 说明 Key / Issuer / 角色不对。

证书与凭据只影响 `pnpm dist`（发版）；只想快速出个能跑的包用 `pnpm dist:dir`（不签名、不公证）。
证书到期（当前 2027-12-13）后续期，续期后重跑一次 `pnpm dist` 验收。

## 版本策略

| 版本 | 说明 |
|---|---|
| `0.0.1` | 内部开发版，不发布 |
| `0.0.2` | 第一个公开版 |
| `0.0.3`、`0.0.4` … | 日常发版，**一律 patch** |

- 版本号唯一真源是 `apps/desktop/package.json`；根 `package.json` 不带 `version` 字段。
- **完全手动**：直接编辑那个字段，`pnpm release` 只读不写，也不接受 `--bump` / `--version` 参数。
- 不做预发布版本，每次发版一律 patch。
- 发版门槛只有两件与源码仓库无关的事：**发布说明必须存在且非空**、`pnpm test` 通过。脚本不检查分支、工作区或 tag。

## 每次发版

### 1. 改版本号（不构建）

编辑 `apps/desktop/package.json` 的 `version`，例如 `0.0.3`。没有脚本代劳——这是唯一真源。

### 2. 写发布说明

编辑 `docs/releases/v0.0.3.md`（复制上一版改名即可）。这份内容会同时出现在 GitHub Release 和客户端「关于」面板里。

文件缺失、或内容只有空白，`pnpm release` 直接中止；没有跳过开关。说明文件不必提交——脚本不读 git 状态。

**签名首发那版要写明**：macOS 包已签名并公证，首次打开不再需要右键 / `xattr` 放行；
从旧版本自动更新上来的那一次仍由旧版（未签名）执行替换，更新完成后才进入"无提示"状态。

**文件格式变更必须写进说明**：`.sqraft` 的 `formatVersion` 提升后，旧版本客户端打开新文件不会报错，但会**静默丢弃**它不认识的新字段（例如 0.0.4 的原型链接）。发布说明里要写清"用旧版本打开会丢失什么"，不能只列新增功能。

### 3. 出包 + 创建 draft

构建与上传分开：`pnpm dist` 只负责构建（并写 `release/build.json`），`pnpm release` 只负责验收与上传。
上传失败可以单独重跑，不用再花几分钟重建。

**macOS（本机）**

```bash
pnpm dist          # clean → 类型检查 + 构建 → 签名 → 公证 → dmg + zip → verify-pack → 写 build.json
```

公证需要联网，通常 1–3 分钟（首次可能更久）；失败会直接中止、不产出 dmg / zip，
改完重跑即可。`pnpm dist:dir` 只出未打包目录（adhoc、不公证），不能发版。

**Windows（另一台机器）**

仓库拉到 Windows，`pnpm install && pnpm dist`（按宿主平台出 x64 的 NSIS 安装器），
得到 `release/Sqraft-Setup-<version>.exe`，并在那台机器上按第 4 节的清单手点一遍。
把 exe 拷回 mac 的 `apps/desktop/release/`。

**创建 draft**

```bash
pnpm release
# 或：pnpm release --win ~/Downloads/Sqraft-Setup-0.0.5.exe
```

依次执行：预检（发布说明存在、版本大于最新已发布版本、发行仓没有同名 release、gh 可用且仓库 public、
四语言 README 一致、`dependencies` 为空）→ 读 `release/build.json`（版本要对、commit 必须是 HEAD、
签名 / 公证信息齐全）→ 检查 `release/` 里 dmg / zip / exe 齐全 → `pnpm test` →
`verify-pack --expect-signed`（ADR-0030 / ADR-0034）→
sha256 → `latest.json`（`mac-arm64` / `mac-arm64-dmg` / `win-x64` 三个键）→
`gh release create v<version> --draft` → 逐个 `gh release upload --clobber` → 回读断言四个资产齐全。

`build.json` 是"构建与上传解耦"的防护：commit 不是 HEAD、版本对不上、或产物不在清单里，
都直接中止——不会出现"改完代码忘了重新 dist，把旧包发出去"。构建时工作区不干净只告警。

`pnpm release` 不接受版本参数：版本只认 `apps/desktop/package.json`。
发布说明缺失、测试失败、产物缺失都会直接中止，不会创建 draft。

脚本**不看分支与源码 tag**；发行仓的 `v<version>` tag 由 `gh release create` 创建，
同时充当源码的版本标记。

`verify-pack` 不通过也会中止：asar 里只允许 `out/**` 与 `package.json`，
出现 `.ts` / `.map` / `node_modules`，压缩或 fuse 状态不符合预期，或者（macOS）
签名不是 Developer ID Application、entitlements 缺 `allow-jit`、Gatekeeper 不接受、
公证票据没 staple，都不会把包传上去。
Windows 侧的同一套断言接在 `pnpm dist` 末尾（检查 `release/win-unpacked/resources/app.asar`
与 `Sqraft.exe` 的 fuse），不通过就不会产出可拷走的 exe；`release` 会再跑一次 mac 侧。

draft 阶段线上不可见（`/releases/latest` 仍指向上一个版本），此时**验证不了自动更新**。

**上传失败怎么重试**（draft 已建好，别再跑 `release`）：

```bash
gh release upload v<version> \
  apps/desktop/release/Sqraft-<version>-arm64.dmg \
  apps/desktop/release/Sqraft-<version>-arm64-mac.zip \
  apps/desktop/release/Sqraft-Setup-<version>.exe \
  apps/desktop/release/latest.json \
  --repo wfdx165/sqraft --clobber
```

可选参数：

- `pnpm release --win <路径>`：把指定 exe 复制成 `Sqraft-Setup-<version>.exe` 放进 `release/`
- `pnpm release --publish`：验收后直接正式发布（跳过 draft）
- `pnpm release --preflight`：只跑检查（发布说明 + README + GitHub 侧），不构建、不上传

### 4. 验收 draft

```bash
gh release view v0.0.2 --repo wfdx165/sqraft --json isDraft,assets \
  --jq '{draft:.isDraft, assets:[.assets[].name]}'
```

应看到四个资产：`Sqraft-<version>-arm64.dmg`、`Sqraft-<version>-arm64-mac.zip`、
`Sqraft-Setup-<version>.exe`、`latest.json`。

macOS 装一次再发布。**用浏览器下载**（这样会带上隔离标记，才是用户真实路径），别用 `gh`：

```bash
mkdir -p /tmp/sqraft-check
open https://github.com/wfdx165/sqraft/releases   # 找到 v<version> 的 draft，下载 dmg
```

拖进「应用程序」后双击：**不应出现任何 Gatekeeper 提示**（签名 + 公证生效）。
若出现提示，先在本机复查产物：

```bash
APP=apps/desktop/release/mac-arm64/Sqraft.app
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP" | grep -E "Authority|TeamIdentifier|flags"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP"
```

`spctl` 应输出 `source=Notarized Developer ID`、`stapler validate` 应输出
`The validate action worked`。首次验证签名时建议再开一个干净的 macOS 用户账号
（Gatekeeper 有缓存，同一账号重复安装看不准）。

Windows 侧在装过 `Sqraft-Setup-<version>.exe` 的机器上确认：

- 安装向导能改目录；安装后开始菜单与桌面都有快捷方式；卸载后 `%APPDATA%\Sqraft` 还在
- 双击 `.sqraft` 文件能直接打开
- 新建 → 画图 → 保存 → 关窗重开内容一致；嵌图、MCP 建节点、演示模式都正常
- 工具栏/「关于」里的更新提示能打开下载页

确认：能启动、关于面板版本正确、能新建/保存 `.sqraft`、MCP 能连。

### 5. 正式发布

```bash
pnpm publish:release
```

它不重新构建，只做：检查 draft 资产齐全 → `gh release edit --draft=false` →
轮询 `latest.json` 直到匿名可读（GitHub 的 `latest` 有缓存，通常几秒到半分钟）。

手动复查：

```bash
curl -s https://github.com/wfdx165/sqraft/releases/latest/download/latest.json | head -c 200
```

返回的 `version` 是新版本即成功。

### 6. 改 README / 截图时

四份 README 直接改在本仓库（发行仓就是本仓库），随代码一起提交：

```bash
pnpm --filter @sqraft/desktop run check:readmes
```

校验四份文件齐全、首行语言切换链接完整、二级标题数量一致、许可段都指向 Apache-2.0；
`pnpm release` 的预检与 CI 也会跑同一条命令，不一致直接中止。

## 第一个版本（0.0.2）的特殊之处

- 现有 `0.0.1` 没有更新器，`0.0.2` 必须**手动安装**；
- 首个版本没有"上一版"可测自动更新——真正的更新链路要等 `0.0.3` 才能验证。

## 自动更新验证（发 0.0.3 时）

1. 用 `0.0.2` 的 dmg 装好应用；
2. 发 `0.0.3`（改版本号 → 写说明 → `release` → `publish:release`）；
3. 打开已装的 `0.0.2`：菜单 **帮助 → 检查更新…**（手动检查不受 24 小时节流限制）；
4. 应看到后台下载 → 工具栏出现「重启更新」→ 保存守卫 → 重启 → 关于面板显示 `0.0.3`；
5. 回滚演练：退出应用 → `pnpm stage:update` → 启动 → 重启更新，确认替换与备份清理；
   把 `update.zip` 换成坏包重复一次，确认"回滚 + 提示 + 胶囊不再出现"。

## 故障处理

| 症状 | 处理 |
|---|---|
| 预检报"找不到 gh" | `brew install gh && gh auth login` |
| 预检报 401/403 | `gh auth status`，必要时 `gh auth login`；确认对仓库有写权限 |
| 仓库不是 public | 改成 public（否则更新链路必然 404） |
| `release vX 已存在` | 先改 `apps/desktop/package.json` 的 version；或删掉旧 release 与同名 tag 再重试 |
| 预检报"缺少发布说明" | 写 `docs/releases/vX.Y.Z.md`（可复制上一版）；不能为空 |
| 预检报"版本必须大于最新已发布版本" | 改 `apps/desktop/package.json` 的 version，发版一律 patch |
| `dist: 找不到 Developer ID Application 证书` | Xcode → Manage Certificates 建证书；或先 `pnpm dist:dir` 出个不签名的快包 |
| `dist: 缺少公证凭据` / 凭据不完整 | 在 shell profile 配 `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`（或备用两组），`source` 后重试 |
| 公证报 `401` / `Authentication failed` | Key ID / Issuer ID 对不上，或该 Key 被吊销；重下一把 Team Key |
| `notarytool` 找不到 | 装完整 Xcode（只有 Command Line Tools 没有 notarytool），然后 `sudo xcode-select -s /Applications/Xcode.app` |
| 公证失败 `Invalid` | `xcrun notarytool log <submission-id> --key …` 看原因：常见是 entitlements 缺 `allow-jit`、嵌套包签名不完整 |
| `stapler validate` 失败 | 公证没跑（凭据没生效）或公证后又改过包；重跑 `pnpm dist`，别手工改产物 |
| 公证超时 / 网络错误 | 重跑 `pnpm dist`；API Key 有频率限制，调参阶段用 `pnpm dist:dir` |
| `signing` 之后长时间没有输出 | 正常现象：签名（逐个嵌套 bundle）与公证（上传 + 等 Apple 处理）都不打印进度，通常 1–3 分钟、链路慢时更久。另开终端用 `xcrun notarytool history --key …` 看有没有新提交 |
| 签名阶段异常慢（5 分钟以上/每次发版都这样） | 代理把 `timestamp.apple.com` 劫持到 `198.18.x.x`（fake-ip）会让 `codesign --timestamp` 反复重试。给该域名加 **DIRECT** 规则或临时关 VPN；验收：`dig +short timestamp.apple.com` 返回真实 Apple IP |
| 构建失败 | 版本号已改好，修完直接重跑 `pnpm dist` |
| 资产缺失 / 体积异常 | 删掉 draft 重跑，不要手动补传（sha256 必须和包一致） |
| 发布后才发现包坏了 | 用户侧会回滚；发下一个 patch 版本修复，不回滚 tag |
| `latest.json` 一时还是旧版本 | GitHub 缓存，等几十秒重试；`publish:release` 已经内置轮询 |

## 元数据与文件

`latest.json`（由 `release.mjs` 生成，作为 Release 资产上传）：

```json
{
  "version": "0.0.3",
  "publishedAt": "2026-11-08T09:00:00.000Z",
  "notes": "…",
  "assets": {
    "mac-arm64": { "url": "…zip", "size": 123, "sha256": "…" },
    "mac-arm64-dmg": { "url": "…dmg", "size": 123, "sha256": "…" },
    "win-x64": { "url": "…exe", "size": 123, "sha256": "…" }
  }
}
```

- `win-x64` 指向 `Sqraft-Setup-<version>.exe`；Windows 客户端当前只读 `version` 做提示，键为以后接静默安装预留
- 仓库地址的唯一真源：`apps/desktop/update.config.json`（客户端与脚本读同一份）
- 发布说明：`docs/releases/v<version>.md`（必须存在且非空）
- 下载页 README 有四份，改一份要同步其余三份（`pnpm --filter @sqraft/desktop run check:readmes` 会校验）
- 客户端检查地址：`https://github.com/<repo>/releases/latest/download/latest.json`
