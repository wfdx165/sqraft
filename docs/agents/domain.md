# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root：术语唯一真源（Frame=画板、Group=分组、命令、Token、变体…），不要引入同义词
- **`docs/adr/`**：读触及你将要改动区域的 ADR（现有 0001–0022，按顺序编号、短格式）
- **`docs/specs/`**：对应特性的规格（`pen-tool.md`、`component-system.md`、`selection-and-arrange.md` 等），写实现前先看有没有已经定过的语义

缺哪个就静默跳过，不要提示补建。`/domain-modeling` 会在术语或决策真正落地时惰性创建它们。

## File structure

Single-context repo（本仓库即此类：`packages/core`、`packages/render`、`packages/ai-tools` 与 `apps/desktop` 共享同一套领域语言）：

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/
│   │   ├── 0001-command-based-document-model.md
│   │   └── ...
│   ├── specs/
│   └── architecture.md
├── packages/
└── apps/
```

出现 `GLOSSARY-MAP.md` 才说明是 multi-context；本仓库没有，也不要新建。

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007（无限画布页面），但值得重开，因为…_
