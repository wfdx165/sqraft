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

- 版本号唯一真源是根 `package.json`；`apps/desktop/package.json` 必须与它相同（脚本会校验）。
- 不做预发布版本；`--bump minor` / `major` 保留但不用。
- 版本号改完记得提交，让代码和安装包对得上。

## 每次发版

### 1. 升版本（不构建）

```bash
pnpm release --bump          # patch，默认
```

脚本会：

- 预检（gh 是否可用、仓库是否公开且有写权限、两处版本是否一致）
- 定点替换两个 `package.json` 的 `version`（只动这一个字段，写完回读校验，第二份失败会回滚第一份）
- 生成 `docs/releases/v<version>.md` 模板（已存在则跳过）
- 打印下一步，**不构建**

首个公开版用显式版本号（只此一次）：

```bash
pnpm release --version 0.0.2
```

### 2. 写更新说明

编辑 `docs/releases/v0.0.2.md`。这份内容会同时出现在 GitHub Release 和客户端「关于」面板里。

### 3. 出包 + 创建 draft

```bash
pnpm release
```

依次执行：预检 → `clean` → 类型检查 + 构建 → `Sqraft-<version>-arm64.dmg` + `.zip` →
sha256 → `latest.json` → `gh release create v<version> --repo wfdx165/sqraft --draft`。

draft 阶段线上不可见（`/releases/latest` 仍指向上一个版本），此时**验证不了自动更新**。

可选参数：

- `pnpm release --skip-build`：复用 `release/` 里已有产物
- `pnpm release --publish`：构建后直接正式发布（跳过 draft）
- `pnpm release --preflight`：只跑检查，不构建

### 4. 验收 draft

```bash
gh release view v0.0.2 --repo wfdx165/sqraft --json isDraft,assets \
  --jq '{draft:.isDraft, assets:[.assets[].name]}'
```

应看到三个资产：`Sqraft-0.0.2-arm64.dmg`、`Sqraft-0.0.2-arm64.zip`、`latest.json`。

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
2. 发 `0.0.3`（`--bump` → 写说明 → `release` → `publish:release`）；
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
| `release vX 已存在` | 先升版本；或删掉旧 release 与同名 tag 再重试 |
| 构建失败 | 版本号已改好，修完直接重跑 `pnpm release` |
| 资产缺失 / 体积异常 | 删掉 draft 重跑，不要手动补传（sha256 必须和包一致） |
| 发布后才发现包坏了 | 用户侧会回滚；发下一个 patch 版本修复，不回滚 tag |
| `latest.json` 一时还是旧版本 | GitHub 缓存，等几十秒重试；`publish:release` 已经内置轮询 |

## 元数据与文件

`latest.json`（由 `release.mjs` 生成，作为 Release 资产上传）：

```json
{
  "version": "0.0.2",
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
