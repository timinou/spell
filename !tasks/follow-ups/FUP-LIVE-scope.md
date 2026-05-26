# FUP-LIVE — scope doc

**Goal**: wire `pi-natives::code_path::type_resolver` into the live find/edit path so semantic qualifiers (`#hover`, `#signature`, `#type_definition`, `#inlay`, `#diagnostics`) reach `SemanticBackend` (AnnotationSemanticBackend + per-language LspSemanticBackend) instead of returning "unknown qualifier" or text-only signatures.

**Why "LIVE"**: the dispatch library was shipped in PLAN-319 W3 but has zero call sites outside its own tests. This task lights it up.

---

## Building blocks already in place ✓

| component | location | status |
|---|---|---|
| `SemanticBackend` trait | `pi-code-graph::semantic::mod` | ✓ stable, hover_dual default impl + Composite override |
| `AnnotationSemanticBackend` | `pi-code-graph::semantic::annotation` | ✓ takes `Arc<CodeGraph>` |
| `CompositeSemanticBackend` | `pi-code-graph::semantic::composite` | ✓ takes annotation default, `register_lsp(exts, backend)` |
| `LspSemanticBackend` | `pi-code-graph::semantic::lsp::backend` | ✓ takes `Arc<LspClient>` |
| `LspRegistry::get_or_spawn` | `pi-code-graph::semantic::lsp::registry` | ✓ workspace-keyed, LRU cap, install-hint on failure |
| `LspClient` | `pi-code-graph::semantic::lsp::client` | ✓ **synchronous** (deliberately, see module comment) |
| `SemanticConfig::load_layered(project_root)` | `pi-code-graph::semantic::config` | ✓ KDL parser, layered defaults |
| `defaults.kdl` | `pi-code-graph::semantic::defaults.kdl` | ✓ ships with Elixir/Expert entry |
| `type_resolver::dispatch` | `pi-natives::code_path::type_resolver` | ✓ full dispatch matrix, smart-merge, source predicate, severity filter |
| `type_resolver::format_hover` | same | ✓ HoverOutcome → String |
| `DocumentSync` | `pi-code-graph::semantic::lsp::sync` | ✓ didOpen/didChange/didSave/didClose |
| `code_graph_cache::get_or_build_graph` | `pi-natives::code_graph_cache` | ✓ pattern to mirror |
| `SessionContext { project_root, session_dir, home }` | `pi-code-path::scheme` | ✓ threaded through napi.rs |

---

## Building blocks missing ✗

### M-1 — per-workspace SemanticBackend cache (NEW file)

`crates/pi-natives/src/semantic_cache.rs` — direct copy of `code_graph_cache.rs` shape:

```rust
static WORKSPACE_BACKENDS: OnceLock<DashMap<PathBuf, CachedBackend>> = OnceLock::new();

pub struct CachedBackend {
    pub composite: Arc<CompositeSemanticBackend>,
    pub registry:  Arc<LspRegistry>,
    pub built_at:  SystemTime,
}

pub fn get_or_build(root: &Path) -> Result<Arc<CompositeSemanticBackend>> {
    let canon = std::fs::canonicalize(root)?;
    if let Some(existing) = backends().get(&canon) {
        return Ok(existing.composite.clone());
    }
    // ── Build path ──
    let graph = code_graph_cache::get_or_build_graph(root)?;
    let annotation = Arc::new(AnnotationSemanticBackend::new(graph));
    let mut composite = CompositeSemanticBackend::new(annotation);

    let config = SemanticConfig::load_layered(root)?.resolve();
    let registry = Arc::new(LspRegistry::new(
        config.max_warm_servers(),
        config.idle_ttl(),
    ));
    for spec in config.server_specs.values() {
        registry.register_spec(spec.clone());
    }
    for (lang, lb) in &config.language_backends {
        let Some(server_name) = &lb.lsp else { continue };
        match registry.get_or_spawn(root, server_name) {
            Ok(client) => {
                let backend = Arc::new(LspSemanticBackend::new(client));
                let exts = config.server_specs[server_name].file_types.clone();
                composite.register_lsp(exts, backend);
            }
            Err(LspClientError::SpawnFailed(msg)) => {
                // Fail-graceful: log + continue with annotation-only for this language.
                tracing::warn!("LSP spawn failed for {lang}/{server_name}: {msg}");
            }
            Err(e) => return Err(e.into()),
        }
    }
    let arc = Arc::new(composite);
    backends().insert(canon, CachedBackend { composite: arc.clone(), registry, built_at: SystemTime::now() });
    Ok(arc)
}

pub fn invalidate(root: &Path) { … }     // mirror code_graph_cache
pub fn invalidate_for_file(file_path: &Path) -> usize { … }
```

**~80 LOC. Mechanical.**

### M-2 — semantic dispatch path at napi.rs entry (NOT walker)

The wiring lives at `crates/pi-natives/src/code_path/napi.rs`, not in walker. Rationale:
- walker.rs is pure tree-sitter; threading SemanticBackend through it pollutes its abstraction
- napi.rs already has session_ctx + root, the exact context the cache needs
- Mirrors the existing pattern: `is_diff_qualifier` is routed at napi.rs:873 _before_ FsResolver

New helper in napi.rs:

```rust
fn is_semantic_qualifier_at_napi(cp: &CodePath) -> bool {
    cp.qualifier.as_ref().is_some_and(|q| type_resolver::is_semantic_qualifier(&q.name))
        || cp.qualifier.as_ref().is_some_and(|q| type_resolver::deprecated_qualifier_replacement(&q.name).is_some())
}
```

In the dispatch chain (Locator::Fs branch, around line 822-895), inject **before** the existing FsResolver / CodeResolver path:

```rust
} else if is_semantic_qualifier_at_napi(&cp) {
    semantic_dispatch::resolve(&cp, &root, &pi_token, &cancel_token)?
} else if is_outline_qualifier(&cp) {
    // existing path
}
```

New module `crates/pi-natives/src/code_path/semantic_dispatch.rs` (~150 LOC):

```rust
pub fn resolve(cp: &CodePath, root: &Path, pi: &PiToken, ct: &CancelToken)
    -> Result<Vec<NodeRef>> {
    let backend = semantic_cache::get_or_build(root)?;
    let q = cp.qualifier.as_ref().unwrap();
    let preds = collect_predicates(cp);  // walk head + chain steps

    // Resolve target to (file, line, col):
    //   • File-only (e.g. `foo.rs#diagnostics`): line=1, col=1
    //   • Symbol-scoped: re-use code_resolver to find the symbol node, take its start position
    let positions = resolve_positions(cp, root, pi)?;

    let mut nrefs = Vec::with_capacity(positions.len());
    for (file, line, col) in positions {
        let outcome = type_resolver::dispatch(&*backend, q, &preds, &file, line, col);
        nrefs.push(format_outcome(outcome, &file, line, col));
    }
    Ok(nrefs)
}
```

### M-3 — `format_outcome(TypeResolverOutcome) -> NodeRef`

Currently `type_resolver::format_hover` exists for `HoverOutcome → String`. Need a small extension to cover all variants:

```rust
fn format_outcome(outcome: TypeResolverOutcome, file: &Path, line: u32, col: u32) -> NodeRef {
    match outcome {
        TypeResolverOutcome::Hover(h) => mk_text("§hover", type_resolver::format_hover(&h), file, line),
        TypeResolverOutcome::Signature(Some(s)) => mk_text("§signature", format_signature(&s), file, line),
        TypeResolverOutcome::Signature(None) => mk_empty("§empty", file, line),
        TypeResolverOutcome::TypeDefinition(Some(loc)) => mk_location("§type_definition", &loc),
        TypeResolverOutcome::TypeDefinition(None) => mk_empty(…),
        TypeResolverOutcome::Inlay(hints) if hints.is_empty() => mk_empty(…),
        TypeResolverOutcome::Inlay(hints) => mk_text("§inlay", format_inlay(&hints), …),
        TypeResolverOutcome::Diagnostics(d) if d.is_empty() => mk_empty(…),
        TypeResolverOutcome::Diagnostics(d) => mk_diag_list("§diagnostics", &d, file),
        TypeResolverOutcome::Deprecated { name, replacement } => {
            mk_text("§deprecated", format!("qualifier #{name} is deprecated; use #{replacement}"), file, line)
        }
        TypeResolverOutcome::NotASemanticQualifier => unreachable!("guarded at napi entry"),
    }
}
```

**~80 LOC. Belongs in semantic_dispatch.rs or a sibling format module.**

### M-4 — remove walker's `#hover` text-only special-case

`walker.rs:163-185` currently handles `#hover` directly as a text-based sig extraction. This needs to be DELETED — `#hover` now flows through napi.rs → semantic_dispatch → type_resolver. The Annotation backend covers the same ground (with the smart-merge advantage of also taking LSP into account when available).

**Caveat**: `AnnotationSemanticBackend::type_at` must produce the written signature when the graph has the symbol. Need to verify it does; if not, that's an additional small fix in annotation.rs. (Check before deleting walker's path.)

### M-5 — `LspClient` blocking-safety on the find request path

LspClient is sync. A query that times out (rust-analyzer cold start, etc.) blocks the find call for `request_timeout` (config-configurable, default 5s). Acceptable for v1; the timeout is bounded and per-query. Could later be wrapped in `tokio::task::spawn_blocking` if the find path becomes async.

### M-6 — buffer-sync wiring

The `DocumentSync` module exists. For SemanticBackend's LSP path to see correct file content, every code_buffer mutation needs to notify it (didChange). Currently the wiring point exists for code_graph_cache::invalidate_for_file (single-source-of-truth event stream per FUP-092). Just need to also call `DocumentSync.handle(BufferEvent::Changed { … })` on each cached LSP client.

**Effort: ~30 LOC at the existing invalidate-on-write callsite in pi-natives::code_buffer.**

### M-7 — fixture-based integration test

`crates/pi-natives/tests/semantic_live_e2e.rs`:

```rust
#[test]
fn hover_dispatches_through_semantic_backend() {
    let root = …; // setup workspace with rust file containing `fn foo() -> i32 { 42 }`
    let result = execute_codepath(&format!("{root}/src/main.rs::foo#hover"));
    let text = result.first_text();
    assert!(text.contains("fn foo()") || text.contains("-> i32"));
    // Note: this exercises the AnnotationSemanticBackend path. Full smart-merge
    // requires an LSP — skip-if-unavailable for `expert` / `rust-analyzer`.
}

#[test]
#[ignore = "requires rust-analyzer in PATH"]
fn hover_smart_merge_when_lsp_available() {
    if !cmd_exists("rust-analyzer") { return; }
    // ... assert HoverOutcome::Agreed or Disagreed comes through
}

#[test]
fn diagnostics_at_file_scope_dispatches() { … }
#[test]
fn signature_qualifier_dispatches() { … }
#[test]
fn type_definition_qualifier_dispatches() { … }
#[test]
fn inlay_qualifier_dispatches() { … }
#[test]
fn deprecated_hover_inferred_returns_deprecated_outcome() { … }
```

### M-8 — defaults.kdl needs Rust/TS entries

Currently only Elixir is wired. For the integration tests + your earlier "Rust pilot" goal, add minimal Rust + TypeScript stanzas:

```kdl
language "rust" { lsp "rust-analyzer" }
language "typescript" { lsp "typescript-language-server" }

server "rust-analyzer" {
    command "rust-analyzer"
    file-types ".rs"
    root-markers "Cargo.toml" "Cargo.lock"
    request-timeout-secs 10
}

server "typescript-language-server" {
    command "typescript-language-server"
    args "--stdio"
    file-types ".ts" ".tsx" ".mts" ".cts" ".js" ".jsx"
    root-markers "package.json" "tsconfig.json"
    request-timeout-secs 10
}
```

This is technically scope-creep into FUP-094 but unavoidable to write meaningful integration tests for FUP-LIVE.

---

## Architecture diagram

```
                    find tool target
                          │
              CodePath parse (existing)
                          │
                    ┌─────▼─────┐
                    │  napi.rs  │  ←── ENTRY POINT
                    └─────┬─────┘
                          │
              is_semantic_qualifier(cp)?
                          │
              ┌───── yes ─┴── no ─────┐
              │                       │
              ▼                       ▼
   semantic_dispatch::resolve   existing FsResolver
              │                  / CodeResolver paths
              ▼
   semantic_cache::get_or_build(root)  ←── NEW
              │
              ▼
   ┌─────────────────────────────────┐
   │ CompositeSemanticBackend         │
   │   default: AnnotationSemanticB.  │
   │   by_ext:                        │
   │     "rs"  → LspSemanticBackend  ─┼──→ rust-analyzer
   │     "ts"  → LspSemanticBackend  ─┼──→ typescript-language-server
   │     "ex"  → LspSemanticBackend  ─┼──→ expert
   └────────────┬─────────────────────┘
                │
                ▼
   type_resolver::dispatch(backend, q, preds, file, line, col)
                │
                ▼
        TypeResolverOutcome (Hover|Signature|TypeDefinition|Inlay|Diagnostics|Deprecated)
                │
                ▼
        format_outcome → NodeRef → wire output
```

---

## Touch-point summary

| # | File | LOC | Risk |
|---|---|---|---|
| M-1 | `pi-natives::semantic_cache` (NEW) | ~80 | low — mirror existing pattern |
| M-2 | `pi-natives::code_path::semantic_dispatch` (NEW) | ~150 | medium — coordinate translation, position resolution |
| M-3 | format helpers (in M-2 module) | ~80 | low |
| M-4 | `walker.rs` delete `#hover` text path | -25 | low — but verify Annotation backend covers it |
| M-5 | accept blocking LSP requests | 0 | none (deliberate design) |
| M-6 | `code_buffer` → DocumentSync notification | ~30 | medium — must wire to same event source as code_graph_cache::invalidate |
| M-7 | integration test file (NEW) | ~200 | low |
| M-8 | `defaults.kdl` add Rust + TS | ~25 | low (overlaps FUP-094) |
| napi.rs | add 1 helper + 1 branch | ~10 | low |

**Total**: ~580 LOC net new, ~25 deleted. **2-3 day estimate stands.**

---

## Risks & open questions

1. **AnnotationSemanticBackend's `type_at` quality** — ✓ **VERIFIED**. `type_at` reads `sym.detail`; the EngineProfileExtractor populates it via `signature_snippet(source, node, decl)` at `generic.rs:155`. Quality matches walker's current text-based extraction for symbols indexed in the graph. M-4 deletion is safe; for symbols outside the graph (rare), result is `InferResult::unknown()` → `[§empty]` (minor regression vs current always-something behaviour; acceptable since outside-of-graph is the rare path).

2. **Symbol position from CodePath target** — for `foo.rs::Bar.method#hover`, the symbol resolver gives a tree-sitter node; column needs to be the start of the *name* identifier, not the start of the declaration. Existing walker already does this via `metadata.line`; need to also expose column.

3. **LSP root detection for monorepos** — `ServerSpec::detect_root` walks up looking for root-markers. In a workspace with nested Cargo.toml, this picks the innermost; may not be what the agent expects. Acceptable for v1.

4. **Concurrent first-query** — if two find calls hit the same workspace before its semantic_cache entry is built, both will try to build. `DashMap.entry()` collapses this; acceptable.

5. **Mid-edit file sync** — if a buffer is dirty and the user calls `#hover`, the LSP needs the latest text (via didChange) BEFORE the request. Current sync module handles it but only if connected to the right event stream. M-6 may need a tiny synchronous flush before each query.

6. **Sandbox / no-LSP CI** — integration tests must skip-not-fail when LSPs aren't installed. `which expert` / `which rust-analyzer` gating in the test setup.

---

## Sequenced implementation

| step | depends on | est | output |
|---|---|---|---|
| 1 | — | 1h | M-1 `semantic_cache.rs` + unit tests |
| 2 | 1 | 2h | M-2 `semantic_dispatch::resolve` + position resolution |
| 3 | 2 | 1h | M-3 `format_outcome` + per-variant formatters |
| 4 | 2 | 30m | napi.rs branch injection (10 LOC) |
| 5 | 4 | 1h | M-7 integration tests: hover/signature/type_def/inlay/diagnostics |
| 6 | — | 30m | spot-check AnnotationSemanticBackend::type_at quality (gates M-4) |
| 7 | 5+6 | 30m | M-4 walker `#hover` deletion (or transitional shim) |
| 8 | — | 30m | M-8 defaults.kdl extensions for Rust + TS |
| 9 | 8 | 30m | one `#[ignore]` test asserting smart-merge with real LSP |
| 10 | 1-9 | 1h | M-6 buffer-sync wiring |
| 11 | 1-10 | 1h | reviewer wave (RevCache, RevDispatch, RevFormat) — parallel |
| 12 | 11 | 1h | gap fixes |
| 13 | 12 | 30m | commit + push |

**Total: ~12h of focused work, conservatively 2 days with reviewer + gap fixes.**

---

## Acceptance bullets (mirrors FUP-098 acceptance, recut)

1. `find { ::Sym#hover }` returns smart-merged hover (Annotation + LSP if available)
2. `find { ::Sym#hover [source=graph] }` returns only the Annotation half with `[source: graph]` label
3. `find { ::Sym#hover [source=semantic] }` returns only the LSP half with `[source: semantic]` label
4. `find { ::Sym#hover_inferred }` returns `[§deprecated] qualifier #hover_inferred is deprecated; use #hover [source=semantic]`
5. `find { ::Sym#signature }` returns LSP signature (or `[§empty]` if unavailable)
6. `find { ::Sym#type_definition }` returns the type's declaration site
7. `find { ::Sym#inlay }` returns inlay hints
8. `find { foo.rs#diagnostics }` returns LSP diagnostics for the file
9. `find { foo.rs#diagnostics [severity=error] }` filters to error-level only
10. `edit { ::Sym#hover }` returns the SemanticReadOnly diagnostic (this part is from FUP-098 F-3 — independent)

---

## What's in FUP-LIVE vs what's still separate

- **In FUP-LIVE**: M-1..M-8 above. Lights up the semantic dispatch end-to-end.
- **Still in FUP-098 (revised)**: F-3 (edit ordering), F-9 (whitespace tolerance). Tiny, independent.
- **Still in FUP-099 (new)**: F-4 (Rust import binding extraction for graph references). Independent.
- **Still in FUP-094**: per-language LSP fan-out (Go/Python/CSS/HTML/Ruby/C/C++/Swift/Kotlin/Lua/Nix/Haskell/Java/Clojure). Becomes mechanical after FUP-LIVE — one stanza in defaults.kdl per language.
- **Still in FUP-095**: TS `lsp` tool deletion. After FUP-094 batch 1.
- **Still in FUP-096b**: codemod safety (dry-run, ceilings, strict transactions). Independent.
