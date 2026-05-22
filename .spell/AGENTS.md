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

### Knowledge daemon (PLAN-315)
- `pi-knowledge-worker` is the user-scoped daemon serving the org/memory recall lane (and, post-FUP-089, the code-graph lane). Renamed from `pi-embedding-worker` in W1; legacy binary symlink + `embed.sock` + `PI_EMBEDDING_WORKER` env are retained one release as fallbacks.
- Wire protocol: line-delimited JSON over `$XDG_RUNTIME_DIR/spell/knowledge.sock`. `init` returns `{protocol_version: 2, supported_commands: [...]}`. Knowledge surface: `open`/`close`/`stats`/`search`/`about`/`neighbors`/`since`.
- Per-repo cache: FNV-1a 64 `repo_handle = fnv:xxxxxxxxxxxxxxxx`; LRU eviction via `KNOWLEDGE_MAX_WARM_REPOS` (default 8) and `KNOWLEDGE_IDLE_TTL_SECS` (default 1800).
- Sessions auto-spawn the daemon on first connect; fall back to in-process `WarmEngine` (`pi-natives::recall_engine`) if the daemon socket is unreachable. The fast path is gated by `embedding_worker::knowledge_capable()` which memoises capabilities from the `init` response.
- `:RELATIONS:` and `:PROPERTIES:` drawers at file scope (before any heading) are parsed by `pi-org-engine::buffer::extract_file_level_item` (W7 fix); they propagate to the file-level OrgItem and thence to TypedGraph so `memory.about` returns proper neighbors for concept/episode notes.

### Test isolation (BUG-390)
- `pi-natives::embedding_worker::lock_test_env()` returns an `RwLockWriteGuard`; `lock_test_env_read()` returns a shared guard. Tests that *mutate* `HOME`/`PI_KNOWLEDGE_WORKER` take the write lock; tests that only *read* `HOME` via subprocess (e.g. `git init`, `ignore::WalkBuilder`) take the read lock so they can run in parallel with each other but block any HOME-mutating writer mid-transition.
- `pi-natives::code_buffer::tests::execute_code_buffer_inner_persisted_edit_preserves_undo_history` and the two `pi-workspace-cache` filesystem-walking tests have inline test mutexes to serialise against the process-global buffer_registry and the `ignore` walker's HOME-dependent code path.

