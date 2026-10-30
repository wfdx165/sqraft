# Issue tracker: Local Markdown

Issues live as markdown files under `.scratch/`. Specs live in `docs/specs/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `docs/specs/<feature-slug>.md`（`pen-tool.md`、`component-system.md` 等已是这个形状；`.scratch/desktop/spec.md` 属早期遗留，保持不动）
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 起按依赖顺序编号（blockers 在前），一张票一个文件，绝不合并成一个 tickets 文件
- 每张票文件头部固定三行：`**What to build:**`、`**Blocked by:**`（票号或 `None (can start immediately)`）、`**Status:**`，正文是一组 `- [ ]` 验收项
- Triage state 记在 `Status:` 行：`ready-for-agent` / `ready-for-human` / `needs-info` / `wontfix`（本仓库未安装 triage skill，这些字符串只是约定，没有自动流转）
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Write a file under `.scratch/<feature-slug>/`（目录不存在就建）。规格写 `docs/specs/<feature-slug>.md`，实现票写 `.scratch/<feature-slug>/issues/`。

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user normally passes the path or the ticket number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
