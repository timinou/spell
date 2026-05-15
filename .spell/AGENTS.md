# Project Context

## Overview
spell-monorepo -- javascript

## Development
- Test: `bun run --workspaces --if-present --parallel test`
- Check: `bun run --parallel check:ts check:rs`
- Lint: `bun run --parallel lint:ts lint:rs`

## Conventions

### Tool surface (PLAN-306, in flight)
- `find { target }` is the read/search/list/stat tool. `target` is a CodePath: `path` · `glob` · `path::Symbol` · `path:A-B` · `uri://...`. See `packages/coding-agent/src/prompts/tools/find.md`.
- `edit { operations: [{ target, action: { kind, ... } }] }` mutates. Symbol-first targets (`path::Symbol`) preferred over file targets. `kind: "undo" | "redo"` for history ops (must be alone in batch).
- `status { command }` is kernel observability: `languages` · `index` · `watcherStatus` · `lockStatus` · `status`. NOT for save/diff/buffers (auto-saves; diff via `find ... #diff` post-kernel-rebuild).
- `create { path, content }` for new files; `edit` for overwrites.
- `bash { command }` for processes only (build, test, git, scripts). Not for cat/grep/sed/head/tail/wc/find/ls — use `find`.
- Legacy `get` and `manage` tools still registered as `REMOVE_AT_WAVE_11` aliases.
