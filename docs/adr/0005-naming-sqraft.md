# 命名 Sqraft（Square + Craft）

产品定名 **Sqraft**：Square（方形）+ Craft（工艺）——UI 设计的原子是方形，设计是手艺。命名经系统性查重后确定（2026-10），查重使用两套独立工具交叉核验（Chrome DevTools MCP + Playwright MCP）。

淘汰记录（有据可查，防止未来"为什么不用 X"的复议）：

| 候选 | 淘汰原因 |
|---|---|
| 墨方 | 同名钓鱼电商 app、解谜游戏、装饰公司 |
| 笔墨 / Bimo | 笔墨AI（论文平台）、笔墨写作；多款同名社交 app |
| Sumi | Sumi（Claude Code 设计技能）、Sumi Design System（React 库）——设计圈正面相撞 |
| Inkstone | AI 角色扮演 app、汉字学习 app、macOS 笔记 app |
| Griddo | 大学门户 DXP（App Store）、工作区产品 |
| De Stijl | De Stijl Art Factory（App Store 真实存在） |
| WuFang / 无方 | Wufang Elearning（App Store）、不方（美图）、丹道无方 |
| Kanvaso | 马来西亚设计公司 Kanvaso Digital（设计赛道相撞） |
| Modulor | 家装 app、GR8 Tech 设计系统、BIM 软件 |
| 方寸 | 与大量测量标注工具混淆 |
| 尺规 / Chigui | chigui.com 已被注册；搜索与量尺工具混淆；西语中为"豚鼠"（102 个相关仓库） |

最终 Sqraft 资产清单（全清）：npm 包名（registry 404）、sqraft.com（RDAP 404）、GitHub 用户名（当时 404；现为 `wfdx165/sqraft`）、应用商店无同名产品、搜索引擎无混淆项。

## Consequences

- 包名、文件扩展名（`.sqraft`）、仓库名统一使用 `sqraft`。
- 发布任何公开资产前重跑一遍本清单（npm/域名/GitHub/商店），避免中间被抢注。
