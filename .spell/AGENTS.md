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
- Legacy `get` tool still registered as a `REMOVE_AT_WAVE_11` alias of `find`. `manage` is removed (replaced by `status`).

### Knowledge daemon (PLAN-315)
- `pi-knowledge-worker`: user-scoped daemon serving the org/memory recall lane + code-graph hybrid lane over `$XDG_RUNTIME_DIR/spell/knowledge.sock` (line-delimited JSON). Sessions auto-spawn it; daemon failures are fail-loud query errors.
- Escape hatch: `PI_KNOWLEDGE_WORKER=inprocess` bypasses the socket and serves from the in-process `WarmEngine` (CI, offline, tests).
- Protocol/cache/subscription internals: memory concept `CON-pi-knowledge-worker-daemon-internals--pl`.

### URI scheme dispatch (PLAN-310)
- Kernel owns URI dispatch via `SchemeRegistry`. Adding a scheme = one new file in `crates/pi-natives/src/code_path/uri/` exposing `pub fn build(ctx) -> SchemeProfile`. `build.rs` auto-collects.
- Declarative profiles (skill/rule/memory/agent/artifact/jobs/org/pi/local) use `SchemeProfile { root, layout, loader, capabilities }` — no imperative code per scheme.
- Runtime schemes (canvas + MCP-advertised) register via NAPI `registerSchemeCallback(scheme, tsfn, options)` at session init.
- Bash URI tokens are resolved by brush via vendored `WordPreprocessor` hook (`crates/brush-core-vendored/SPELL_PATCHES.md`); no TS-side pre-pass.
- Reserved native schemes (kernel-owned) must not be claimed by runtime callbacks: skill, rule, memory, agent, artifact, jobs, org, pi, local. MCP servers must use a non-conflicting `schemePrefix` or accept the auto-derived (sanitized server name) scheme.
- Supersedes FEAT-721 (TS-only InternalUrlRouter); BUG-388 (kernel URI rejection) is closed by this design.

### Test isolation (BUG-390)
- `pi-natives::embedding_worker::lock_test_env()` returns an `RwLockWriteGuard`; `lock_test_env_read()` returns a shared guard. Tests that *mutate* `HOME`/`PI_KNOWLEDGE_WORKER` take the write lock; tests that only *read* `HOME` via subprocess (e.g. `git init`, `ignore::WalkBuilder`) take the read lock so they can run in parallel with each other but block any HOME-mutating writer mid-transition.
- `pi-natives::code_buffer::tests::execute_code_buffer_inner_persisted_edit_preserves_undo_history` and the two `pi-workspace-cache` filesystem-walking tests have inline test mutexes to serialise against the process-global buffer_registry and the `ignore` walker's HOME-dependent code path.
