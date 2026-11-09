**English** · [中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

# Sqraft

> AI-friendly, lightweight UI design tool — a desktop app with local files that works offline.

Design interfaces with frames, components, auto layout and design tokens; the same capabilities are exposed over **MCP** to agents such as Claude Code and Cursor, so "edit the design in natural language" is a first-class entry point.

The app is fully local: no account, no cloud, no model calls. A design is simply a `.sqraft` file on disk.

![Sqraft editor](docs/images/editor.png)

## Download

### [⬇ Download the latest version](https://github.com/wfdx165/sqraft/releases/latest)

**macOS · Apple Silicon (M series)** · about 120 MB · unsigned

- macOS arm64 only; Intel Macs, Windows and Linux are not supported
- Every release ships both `.dmg` (manual install) and `.zip` (used by the updater); pick `Sqraft-<version>-arm64.dmg` under **Assets** on the Releases page
- Older versions and release notes: [Releases](https://github.com/wfdx165/sqraft/releases)

## Install

1. Open the downloaded `.dmg` and drag **Sqraft** into Applications
2. Gatekeeper blocks the first launch (the app is unsigned); you will see one of two prompts:
   - "Cannot verify the developer": right-click the app → **Open**, or allow it under System Settings → Privacy & Security
   - "Sqraft is damaged": the file is fine, run the command below
3. Afterwards the app checks for updates on launch: new versions download in the background, a "Restart to update" button appears in the toolbar, and quitting or clicking it finishes the upgrade

If you see the "damaged" prompt, drag the app into Applications first, then run:

```bash
xattr -dr com.apple.quarantine /Applications/Sqraft.app
```

Open it again and it works. Later updates are downloaded by the app itself without the quarantine flag, so this prompt does not come back.

If you would rather not auto-update, **Help → Check for Updates…** checks manually at any time.

## What you can do

- **Vector canvas**: rectangles, ellipses, polygons, lines, pen paths, text; infinite canvas with multiple pages
- **Auto layout**: direction, gap, padding, hug / fill / fixed, wrapping, drag to reorder
- **Components**: main components, instances, slots, instance overrides and swapping
- **Design tokens**: colors and numbers (font size, radius, spacing…); change once and it applies everywhere
- **Editing**: multi-select, marquee, align and distribute, drag to reparent, grouping, guides, snapping
- **Effects**: drop shadow, inner shadow, layer blur, background blur
- **Images**: drag in, paste, crop, mask, linked images (cached locally)
- **AI editing**: agents create nodes, change styles and screenshot the result over MCP; one tool call = one undo step
- **Export**: PNG (with scale)
- **Interface languages**: 中文 / English / 日本語 / 한국어, with optional automatic system-language detection

## Connect AI

Sqraft never calls a model and needs no API key. While the app is running it serves an MCP endpoint on localhost, so you can attach the agent you already use:

```
http://127.0.0.1:7331/mcp
```

The app must stay running (there is no CLI, and clients cannot launch it). If the port is taken the app moves to the next free one; the actual address is shown on the welcome page and under **Sqraft → Configure MCP…** (in the File menu on Windows/Linux).

<details>
<summary>Claude Code</summary>

```bash
claude mcp add --transport http sqraft http://127.0.0.1:7331/mcp
```

</details>

<details>
<summary>OpenCode</summary>

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "sqraft": { "type": "remote", "url": "http://127.0.0.1:7331/mcp" }
    }
  }
}
```

</details>

<details>
<summary>Cursor / other mcpServers clients</summary>

```jsonc
{
  "mcpServers": {
    "sqraft": { "url": "http://127.0.0.1:7331/mcp" }
  }
}
```

</details>

The endpoint only listens on `127.0.0.1` and rejects requests carrying an `Origin` header, but it has **no token**: any other process on the same machine can connect. Concurrent requests from multiple clients run one at a time.

## Local-first

- A design is a `.sqraft` file on disk (a zip container: snapshot + image assets); no cloud service involved
- No account, no backend, no telemetry; the only outbound requests are update checks and linked images you added yourself
- Operation logs go to the system log directory (macOS: `~/Library/Logs/Sqraft/`); **Help → Open Logs Folder** takes you there
- Uninstalling removes the app; data and preferences stay in `~/Library/Application Support/Sqraft/` and can be deleted as well

## Build from source

Requirements: macOS on Apple Silicon, Node.js 22.12 (see `.nvmrc`) and pnpm 10.33.4.

```bash
pnpm install
pnpm dev      # electron-vite dev server with renderer HMR
pnpm test     # vitest across packages
pnpm build    # type check + production bundle
pnpm dist     # unsigned macOS arm64 dmg + zip
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and the review process.

## Requirements and known limitations

- **macOS Apple Silicon**; Intel Macs are not supported
- The app is **unsigned and not notarized**: the first launch needs a manual allow (see Install)
- Auto-update is only available on macOS arm64; there are no Windows or Linux builds
- No real-time collaboration, no accounts, no cloud sync

## License and feedback

Sqraft is open source under the [Apache License 2.0](LICENSE). The "Sqraft" name and the application icon are not covered by the license — forks must use a different name and icon.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). For bugs or feature requests, open an [issue](https://github.com/wfdx165/sqraft/issues).

---

Sqraft = **Square** + **Craft**.
