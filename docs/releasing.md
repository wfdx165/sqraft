# 发版手册

Sqraft 只发布 **macOS arm64**：安装包传到公开仓库
[`wfdx165/sqraft`](https://github.com/wfdx165/sqraft)，源码留在私有 Gitea。
自动更新靠该仓库的 `releases/latest/download/latest.json`（ADR-0029）。

> 发行仓库必须保持 **public**。私有仓库 = `latest.json` 404 = 自动更新静默失效。

## 一次性准备

```bash
brew install gh
gh auth login          # GitHub.com → HTTPS → 浏览器授权
gh auth status         # 确认账号对 wfdx165/sqraft 有写权限
```

`gh auth login` 是整条链路上唯一必须人工完成的步骤。

## 版本策略

| 版本 | 说明 |
|---|---|
| `0.0.1` | 内部开发版，不发布 |
| `0.0.2` | 第一个公开版 |
| `0.0.3`、`0.0.4` … | 日常发版，**一律 patch** |

- 版本号唯一真源是 `apps/desktop/package.json`；根 `package.json` 不带 `version` 字段。
- **完全手动**：直接编辑那个字段，`pnpm release` 只读不写，也不接受 `--bump` / `--version` 参数。
- 不做预发布版本，每次发版一律 patch。
- 版本号改完、更新说明写好之后**必须先提交并推送，再打源码 tag**：`pnpm release` 要求工作区干净、HEAD 与 tag 都已推送。

## 每次发版

### 1. 改版本号（不构建）

编辑 `apps/desktop/package.json` 的 `version`，例如 `0.0.3`。没有脚本代劳——这是唯一真源。

### 2. 写更新说明

编辑 `docs/releases/v0.0.3.md`（复制上一版改名即可）。这份内容会同时出现在 GitHub Release 和客户端「关于」面板里。

两个文件都改好后提交并推送，再给源码提交打 tag——`pnpm release` 要求工作区干净、HEAD 已推送、tag 已推送：

```bash
git add apps/desktop/package.json docs/releases/v0.0.3.md
git commit -m "chore: 发布 0.0.3"
git push origin main

git tag -a v0.0.3 -m "Sqraft 0.0.3"
git push origin v0.0.3
```

> tag 建好后如果还要改代码，必须重新提交并移动 tag（`git tag -f v0.0.3` + `git push -f origin v0.0.3`），否则预检会拒绝"tag 不指向 HEAD"。

### 3. 出包 + 创建 draft

```bash
pnpm release
```

依次执行：预检（工作区干净、HEAD 已推送、源码 tag 指向 HEAD、版本大于最新已发布版本、gh 可用）→ `pnpm test` → `clean` →
类型检查 + 构建 → `Sqraft-<version>-arm64.dmg` + `Sqraft-<version>-arm64-mac.zip` → `verify-pack` 成品防护验收（ADR-0030）→
sha256 → `latest.json`（含 commit）→ `gh release create v<version> --repo wfdx165/sqraft --draft`。

`pnpm release` 不接受版本参数：版本只认 `apps/desktop/package.json`。
工作区不干净、HEAD 未推送、源码 tag 缺失或测试失败都会直接中止，不会出包。

`pnpm release` 不会替你打源码 tag。发行仓的 `v<version>` tag 由 `gh release create` 另外创建，
两者同名但不是同一个仓库；排障要检出的是私有仓那个 tag。

`verify-pack` 不通过也会中止：asar 里只允许 `out/**` 与 `package.json`，
出现 `.ts` / `.map` / `node_modules`，或者压缩、fuse 状态不符合预期，都不会把包传上去。
报错信息会指出是"依赖分类改回去了"还是"构建配置被改坏了"。

draft 阶段线上不可见（`/releases/latest` 仍指向上一个版本），此时**验证不了自动更新**。

可选参数：

- `pnpm release --skip-build`：复用 `release/` 里已有产物（跳过测试）
- `pnpm release --publish`：构建后直接正式发布（跳过 draft）
- `pnpm release --preflight`：只跑检查（工作区干净 + HEAD/tag 已推送），不构建

### 4. 验收 draft

```bash
gh release view v0.0.2 --repo wfdx165/sqraft --json isDraft,assets \
  --jq '{draft:.isDraft, assets:[.assets[].name]}'
```

应看到三个资产：`Sqraft-0.0.2-arm64.dmg`、`Sqraft-0.0.2-arm64-mac.zip`、`latest.json`。

装一次再发布：

```bash
mkdir -p /tmp/sqraft-check
gh release download v0.0.2 --repo wfdx165/sqraft --pattern '*arm64.dmg' --dir /tmp/sqraft-check
open /tmp/sqraft-check/*.dmg
```

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

### 6. 同步下载页（改了 README / 截图才需要）

```bash
pnpm publish:readme
```

临时 clone 发行仓库 → 覆盖 `README.md` 与 `docs/images/` → 有变化才提交并推 `main`；
空仓库首次会自动建分支。

## 第一个版本（0.0.2）的特殊之处

- 现有 `0.0.1` 没有更新器，`0.0.2` 必须**手动安装**；
- 发行仓库要先跑一次 `pnpm publish:readme`，否则仓库首页是空的；
- 首个版本没有"上一版"可测自动更新——真正的更新链路要等 `0.0.3` 才能验证。

## 自动更新验证（发 0.0.3 时）

1. 用 `0.0.2` 的 dmg 装好应用；
2. 发 `0.0.3`（改版本号 → 写说明 → 提交并推送 → 打 tag 并推送 → `release` → `publish:release`）；
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
| 预检报"工作区不干净" | 先提交版本号与更新说明；`release/`、`out/` 已被忽略，不影响 |
| 预检报"HEAD 尚未推送" | 先 `git push origin main` |
| 预检报"缺少源码 tag" / "tag 未推送" | 按第 2 步执行 `git tag -a vX -m "Sqraft X"` 与 `git push origin vX` |
| 预检报"tag 不指向当前 HEAD" | 重新提交后移动 tag：`git tag -f vX` + `git push -f origin vX` |
| 构建失败 | 版本号已改好，修完直接重跑 `pnpm release` |
| 资产缺失 / 体积异常 | 删掉 draft 重跑，不要手动补传（sha256 必须和包一致） |
| 发布后才发现包坏了 | 用户侧会回滚；发下一个 patch 版本修复，不回滚 tag |
| `latest.json` 一时还是旧版本 | GitHub 缓存，等几十秒重试；`publish:release` 已经内置轮询 |

## 元数据与文件

`latest.json`（由 `release.mjs` 生成，作为 Release 资产上传）：

```json
{
  "version": "0.0.2",
  "commit": "7fce817…",
  "publishedAt": "2026-11-03T09:00:00.000Z",
  "notes": "…",
  "assets": {
    "mac-arm64": { "url": "…zip", "size": 123, "sha256": "…" },
    "mac-arm64-dmg": { "url": "…dmg", "size": 123, "sha256": "…" }
  }
}
```

- 仓库地址的唯一真源：`apps/desktop/update.config.json`（客户端与脚本读同一份）
- 更新说明：`docs/releases/v<version>.md`
- 客户端检查地址：`https://github.com/<repo>/releases/latest/download/latest.json`
