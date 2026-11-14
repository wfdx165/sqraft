# Contributing to Sqraft

Thanks for taking the time to contribute. This document covers the
development setup, the conventions this codebase follows, and how a
change gets merged.

## Before you start

- For a bug, open an issue with the reproduction steps first.
- For a feature or a refactor, open an issue and describe the approach
  before writing code. Sqraft is a small project with a deliberately
  narrow scope (`docs/roadmap-competitive.md` and `docs/specs/` are not public; ask in
  the issue), and a large pull request that does not fit it will be hard to
  merge.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| macOS | Apple Silicon | Intel Macs are not supported |
| Windows | 10 22H2+ / 11, x64 | ARM64 Windows is not supported |
| Node.js | 22.12.0 | see `.nvmrc` |
| pnpm | 10.33.4 | `packageManager` in `package.json` |

The Electron binary is downloaded on the first `pnpm install` /
`pnpm dev`, so the first run is slow.

## Setup

```bash
pnpm install
pnpm dev      # electron-vite dev server, renderer HMR
pnpm test     # vitest in @sqraft/core, @sqraft/ai-tools, @sqraft/desktop
pnpm build    # type check (main / preload / renderer) + production bundle
```

Packaging runs on the host platform: macOS produces the arm64 dmg + zip
(signed with a Developer ID certificate; notarization is currently off),
Windows produces the x64 NSIS installer (unsigned). Cross-compiling is not
supported (the Windows installer must be built and checked on Windows):

```bash
pnpm dist     # macOS: arm64 dmg + zip; Windows: Sqraft-Setup-<version>.exe
```

## Project layout

| Path | What lives there |
|---|---|
| `apps/desktop/src/main` | Electron main process: windows, menus, file IO, MCP host |
| `apps/desktop/src/preload` | Whitelisted `window.sqraft` bridge |
| `apps/desktop/src/renderer` | Vue UI, document store, command layer, canvas renderer |
| `packages/core` | Document model and commands. No DOM, no browser APIs |
| `packages/render` | Canvas rendering backends |
| `packages/ai-tools` | Tool definitions exposed over MCP |

Architecture: `docs/architecture.md`. Terminology: `GLOSSARY.md`.
Decisions: `docs/adr/` (add a new numbered ADR for anything structural).

## Conventions

- Comments and internal documentation are written in Chinese; identifiers
  are English.
- There is no ESLint or Prettier config. `tsc` is the quality gate.
- **`.vue` files are not type-checked** by `pnpm build` (plain `tsc` does
  not parse SFCs). After changing a renderer component, run the app and
  click through the affected flow.
- Every user-visible string goes through `t()`. New keys must be added to
  all four files under `src/shared/i18n/` (`zh-CN.ts`, `en-US.ts`,
  `ja-JP.ts`, `ko-KR.ts`); the type checker enforces that they stay in
  sync.
- Document mutations go through `DocStore.apply(Command)`. Commands must
  be deterministic: no `Date.now()`, randomness, or IO while applying.
- Never edit `apps/desktop/out/` by hand. It is generated.

## Tests

Add a vitest case when you change behaviour in `packages/*` or in the
command layer. UI behaviour is verified by hand — list what you clicked
in the pull request.

## Pull requests

1. Keep the change focused; one concern per pull request.
2. Run `pnpm test && pnpm build` before pushing. CI runs the same two
   commands on Linux and must be green. Packaging (`pnpm dist`) is not
   part of CI.
3. Describe what changed and how you verified it.
4. Sign the CLA (see below).

## Contributor License Agreement

Before a pull request can be merged, first-time contributors must sign
[CLA.md](CLA.md). Add a comment to the pull request with:

```
I have read the CLA Document and I hereby sign the CLA
```

The signature applies to all your future contributions.

## Security

Do not report security issues in a public issue. See
[SECURITY.md](SECURITY.md).
