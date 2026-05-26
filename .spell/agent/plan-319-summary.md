# PLAN-319 — SemanticBackend foundation + Expert LSP pilot

## Status: ✅ Complete

## Commits (branch: plan-319-semantic-backend)

| Commit | Wave | Summary |
|---|---|---|
| 9069938a6 | (setup) | PLAN-319 + FUP-094/095 org items |
| 445ceab94 | W0 | BM25 incremental + dedup + Semantic foundation |
| a19f34307 | W0g | 11 reviewer findings (2 P1 + 6 P2 + 3 P3) |
| 0ba7261a0 | W1 | pi-code-graph::semantic::lsp client + lifecycle |
| 8befe3745 | W1g | 11 reviewer findings (3 P1 + 5 P2 + 2 P3) |
| 4ca56775d | W1 close marker | (empty, for gate timing) |
| 796f53dbc | W2 | KDL config parser + Expert defaults |
| a841fe6a3 | W2g | 5 reviewer findings (1 P1 + 2 P2 + 2 P3) |
| 1969384 | W2 close marker | (empty) |
| 3be45bedd | W3 | CodePath grammar + dispatch |
| 5435658bf | W3g | 3 reviewer findings (1 P1 + 1 P2 + 1 P3) |
| a825a62 | W3 close marker | (empty) |

## Test count

| Crate | Tests Added |
|---|---|
| pi-knowledge-core | +28 BM25 (incremental + cache schema regression) |
| pi-code-graph | +120 (~bm25 adapter + semantic trait + LSP client + config + W0g/W1g/W2g regression) |
| pi-natives | +14 (type_resolver dispatch) |
| pi-code-path | +3 (W3 parser round-trip) |
| **total** | **~165 new tests, all green** |

## Reviewer waves (real subagents per PLAN-318 protocol)

| Wave | Subagents | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| W0r | 3 parallel | 0 | 2 | 6 | 3 |
| W1r | 3 parallel | 0 | 3 | 5 | 2 |
| W2r | 1 | 0 | 1 | 2 | 2 |
| W3r | 1 | 0 | 1 | 1 | 1 |
| **total** | **8 subagents** | **0** | **7** | **14** | **8** |

All P1s fixed in gap waves. Critical P0 count: **0**.

## Architecture delivered

`pi-code-graph::semantic` — configurable LSP-backed layer with three impls:
- `AnnotationSemanticBackend` (default, reads SymbolNode::detail; no LSP)
- `LspSemanticBackend` (spawns LSP server; PLAN-319 W1)
- `CompositeSemanticBackend` (dispatch by file extension)

Wired via `SemanticConfig` parsed from `semantic {}` KDL block; layered
project > user > defaults precedence with Some-wins scalar merge.

CodePath grammar additions: `#hover_inferred` / `#type_definition` / `#signature`
/ `#inlay` / `#diagnostics` qualifiers + `[type_aware]` / `[severity=…]` /
`[source=semantic|graph|both]` predicates. All parse for free via the
existing open-ended `#<ident>` and `[name=value]` grammars; dispatch in
`pi-natives::code_path::type_resolver`.

## Closed by this plan
- FUP-092 (watcher → cache invalidation) — absorbed by W1 buffer-sync

## Implemented as side effects
- FUP-090 (type-aware refs) — `[type_aware]` predicate wiring; narrow_edge_results helper
- FUP-091 (inferred-type hover) — `#hover_inferred` qualifier

## Sequenced after
- FUP-094 — multi-language LSP wiring (vtsls, rust-analyzer, pyrefly, …)
- FUP-095 — hard-delete packages/coding-agent/src/lsp/ (after TS+Rust+Python in FUP-094)

## Live Expert pilot (deferred from W2 acceptance)
Wiring of a live SemanticBackend instance per workspace at session-start
is sequenced in FUP-094's first batch (Elixir). The infrastructure
(config loader, registry, sync, backend trait impl) is complete and
unit-tested; what remains is plumbing through to the napi dispatch
boundary so `find { lib/agentmaker/foo.ex::handle_event #hover_inferred }`
actually spawns Expert at the agentmaker root.
