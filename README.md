# Spell

Spell is a terminal-native AI coding agent. It runs locally, talks to Claude, and gives you a full-featured TUI with tool calling, plan mode, org-mode project tracking, QML desktop windows, and Emacs code intelligence — all wired together into a single CLI.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/timinou/spell/main/install.sh | bash
```

Supported platforms: **Arch Linux**, **Ubuntu / Debian**, **macOS**.

The script installs Bun and Rust if missing, clones the repo to `~/.local/spell`, builds the native extensions, and links the `spell` binary. It is idempotent — running it again pulls the latest changes and rebuilds.

<details>
<summary>Manual steps</summary>

```bash
# 1. Prerequisites: git, curl, a C compiler, pkg-config + libssl (Linux only)
# 2. Install Bun
curl -fsSL https://bun.sh/install | bash
# 3. Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# 4. Clone
git clone https://github.com/timinou/spell ~/.local/spell
cd ~/.local/spell

# 5. Install JS deps
bun install --frozen-lockfile

# 6. Build native Rust extensions
bun run build:native

# 7. Link the CLI
bun run install:dev
```

After install, `spell --help` should be available in a new shell.

</details>

---

## What's New — week of 2026-03-10

### Features

- **QML desktop mode** — native Qt 6 window bridge with daemon process, push-based event delivery, and screenshot capture. Agent can open, interact with, and screenshot desktop windows without any manual listen loop.
- **Spell onboarding UI** — step-list QML window that guides through initial setup including automatic ADB configuration and Android remote bridge (`apps/spell/`) for controlling a phone from the agent.
- **Org-mode project management** — `org://` protocol handler for plan references; `update` now supports `body`, `title`, `append`, and `note` mutations; session context embedded in new category files.
- **Plan mode improvements** — org draft pre-created at plan entry, initial message prepended on finalization, `org` and `todo_write` tools always available inside plan mode.
- **Emacs code intelligence** — `OutlineEntry` enriched with `end_line`, `column`, `exported`, and `signature`; Rust/Python/Go/Elm outline support; structured warmup pipeline; project-local `treesitter.json`.
- **Multi-path tool support** — `find`, `grep`, `ast_grep`, and `ast_edit` now accept comma- or space-separated path lists.
- **Interactive input submission** — agent can now accept mid-session input from the user without a full restart.

### Fixes

- QML bridge timeout resolved; `onX` theme property naming conflict fixed; daemon stdio handling corrected.
- WM close no longer aborts an active agent turn.
- ADB unauthorized-device guidance surfaced; device filtering tightened.
- Plan mode session access guarded against closure race.
- Error log serialization corrected; APK-unavailable error made actionable.
- `abort()` now correctly sets `state.error`.
- Org plan errors surfaced as warnings rather than silently swallowed.

### Other

- **Renamed**: OMP / omp / kika → **Spell** / spell across the entire codebase and Android package ID.
- **Relicensed**: GPL-3.0-only (original MIT notices retained for compliance).

---

## Development

```bash
# Install dependencies
bun install

# Build native Rust extensions (required once, and after Rust changes)
bun run build:native

# Link the CLI locally
bun run install:dev

# Type-check + lint
bun check

# Watch mode (TUI dev)
bun dev
```
