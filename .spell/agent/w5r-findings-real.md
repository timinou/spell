# PLAN-318 W5 review — re-export chain following

## Files reviewed
- crates/pi-code-graph/src/language.rs (ExtractedImport.is_reexport)
- crates/pi-code-graph/src/language/typescript.rs (parse_export_statement / parse_import_statement)
- crates/pi-code-graph/src/language/generic.rs (rust_imports, python_imports, generic_import)
- crates/pi-code-graph/src/language/clojure.rs, elixir.rs (callsite updates)
- crates/pi-code-graph/src/indexer.rs (Aliases edge emission alongside Imports)
- crates/pi-code-graph/src/query.rs (test fixture updates)
- crates/pi-natives/src/code_path/edge_resolver/mod.rs (neighbours_with_reexport, symbol_defining_file)
- crates/pi-natives/tests/reexport_e2e.rs + fixtures (reexport_root.ts, tool_target.ts)

## Verdict: needs-fix

The core design is sound and the surface coverage answers the spec questions:
- TS `import { x } from './y'` → is_reexport: false ✓ (parse_import_statement both branches)
- TS `export type * from './y'` → both is_type_only AND is_reexport true ✓ (starts_with("export type") test still applies)
- Rust `use foo::Bar;` (no pub) → is_reexport: false ✓ (raw.starts_with("pub") is false)
- Rust visibilities: `pub`, `pub(crate)`, `pub(super)`, `pub(in path)` — all detected ✓ (starts_with("pub"))
- Aliases edge direction: from_index (re-exporter) → to_index (origin) ✓ ; neighbors walk incoming Aliases to find re-exporters of a file. ✓
- symbol_defining_file: walks single incoming Defines edge; indexer emits exactly one Defines per (file → symbol). ✓

But the implementation has one clear behavioural defect, one mis-described limitation, and material test-coverage gaps.

## Findings

### F1 [HIGH] depth>1 path drops re-export following — asymmetric semantics
File: crates/pi-natives/src/code_path/edge_resolver/mod.rs:271-308
Only the `if max_depth == 1` branch uses `neighbours_with_reexport`. The `else` branch (depth ≥ 2) calls `self.neighbors(*node, graph_kind, is_incoming)` directly. So `def→ depth=2` (or any depth>1) on a re-exported wildcard symbol silently returns zero re-exporters even though depth=1 would return them. This is a regression of intent within W5 itself: users who pass `depth: ...` to follow longer chains lose the W5 behaviour they were promised. Fix: at minimum, run `neighbours_with_reexport` for the initial expansion in the BFS loop; ideally for every level so transitive re-export chains compose with reference chains.

### F2 [MED] neighbours_with_reexport mixes File and Symbol NodeRefs in results
File: crates/pi-natives/src/code_path/edge_resolver/mod.rs:165-189
The base `self.neighbors(node, References, incoming)` for a symbol returns Symbol nodes (call sites / reference sites). The added Aliases hop appends FILE nodes (re-exporter files). Callers consuming `def→` will receive a heterogeneous set where some NodeRefs have `kind: "function"|"class"|...` and others have `kind: "file"`. For wildcard re-exports (no bindings) the file is the only signal — but for named re-exports, the indexer already emits a per-binding References edge (file → original symbol) so the file shows up via that path; the Aliases hop then re-adds the same node (deduped via `.contains`, O(n²) but fine at current cardinalities). Worth either documenting that `def→` on a re-exported symbol can return File NodeRefs, or projecting Aliases hits onto the symbols defined inside the re-exporter (i.e. re-exporting the canonical symbol) so the result set stays uniform.

### F3 [MED] Misleading doc comment claims a hop that the code does not perform
File: crates/pi-natives/src/code_path/edge_resolver/mod.rs:181-184
The comment reads: `// One more hop: anyone who imports the re-exporter sees the symbol too, but we cap at depth-1 here to avoid blow-up.` The code does not perform that hop at all — it stops at the immediate re-exporter file. Consumers that `import { Sym } from './reexport_root'` are NOT walked. The doc misleads future maintainers into thinking transitive consumers are returned. Fix: rewrite the comment to state the actual semantics — “re-exporter files appear as direct referrers; consumers of the re-exporter are not chased.”

### F4 [MED] Re-export chain A→B→C is silently truncated to a single hop
File: crates/pi-natives/src/code_path/edge_resolver/mod.rs:178-187
For a graph A `pub use B::Sym;` and B `pub use C::Sym;`, querying `def→` on `C::Sym` finds B (incoming Aliases to C) but not A (incoming Aliases to B). This is documented inside the function ("cap at depth-1"), but it's not surfaced anywhere a caller can see — the CodePath docs/find.md don't note it, and the e2e test asserts nothing about chain depth. Bound is a deliberate choice for blowup control, but should either (a) be configurable via the `depth` argument the caller already passes, or (b) be promoted into user-facing docs. Today an A→B→C chain misleads consumers about the “who references this?” answer.

### F5 [MED] e2e test does not actually exercise the W5 behaviour it claims to cover
File: crates/pi-natives/tests/reexport_e2e.rs (entire file) + fixtures
The fixture has a re-exporter (`reexport_root.ts`) and a target (`tool_target.ts`) but no consumer file. The single test asserts `!chunks.is_empty()`. That assertion is satisfied even when:
- `is_reexport` is never set to true (the regular Imports edge alone returns the target file as an outgoing import — and `def→` returns the references that already exist via References edges from the explicit bindings or any default fallback).
- the Aliases edge is never emitted.
- `neighbours_with_reexport` is a no-op.
The test would pass with the entire W5 feature removed. The author acknowledges this in the body comment ("the fixture has no actual consumer file"). Add at minimum:
  1. A consumer fixture `consumer.ts` doing `import { ToolThing } from './reexport_root'`.
  2. Assert `reexport_root.ts` (or the consumer file when chained via consumer) appears in the `def→` result NodeRefs by locator substring.
  3. A negative test: a plain `import` (no `export ... from`) does NOT produce the same result — guards against a regression where `is_reexport: false` paths still emit Aliases.

### F6 [LOW] Indexer emits duplicate Aliases edges when the same target is re-exported twice
File: crates/pi-code-graph/src/indexer.rs:170-178
If a file does `export * from './y'` and also `export { Foo } from './y'`, two Aliases edges (parallel, same direction, same kind) land in the petgraph. neighbours_with_reexport's `.contains()` dedupes downstream, but the graph itself carries duplicate edges that count separately in edge counts (e.g. `count_edges(EdgeKind::Aliases)` in tests) and hybrid scoring (hybrid.rs treats Aliases as a boost edge). Either dedupe at emission (already done elsewhere via per-(from,to,kind) sets in many indexers — verify), or document that Aliases edges may be parallel.

### F7 [LOW] `rust_imports` is_reexport is set via `raw.starts_with("pub")` before any tab handling
File: crates/pi-code-graph/src/language/generic.rs:222-237
`raw = text.trim()` followed by `is_reexport = raw.starts_with("pub")`. After stripping `pub `, if the source contains `pub\tuse foo;` (tab between keyword and `use`), `strip_prefix("pub ")` fails, the `pub(` branch is also not taken, and we fall through to `strip_prefix("use ")` which fails. The import is silently dropped, even though `is_reexport` was just set to true. The same dead-end exists for `pub<newline>use foo;` and other whitespace variants. Not introduced by W5 (the strip_prefix existed pre-patch), but W5 now silently inconsistent-states an import that will be discarded. Use a regex like `^pub(\([^)]*\))?\s+use\s+` or strip with `trim_start_matches` semantics.

### F8 [LOW] python_imports always sets is_reexport: false even for explicit re-export idioms
File: crates/pi-code-graph/src/language/generic.rs:300-336
Python re-exports are encoded as `from .x import Foo` followed by `__all__ = ["Foo"]` — or simply `from .x import Foo as Foo`. Both are intentional re-export markers (especially in `__init__.py` modules). W5 hard-codes is_reexport: false for all Python imports. The spec only required TS + Rust, but the asymmetry will surface as “Python re-exports don’t follow” the moment a user tries it. Should be documented as a limitation, or extended in a follow-up.

### F9 [LOW] `kernel_kind_for_reexport = kind.clone()` is the only Clone of KernelEdgeKind in the resolver
File: crates/pi-natives/src/code_path/edge_resolver/mod.rs:258
Functionally fine (Clone is derived on KernelEdgeKind), but it’s clearer to either pass `&kind` to `to_graph_edge` (changing the signature) or move the to_graph_edge call after the matches. Stylistic; not a defect.

## Coverage gaps
1. No test asserts `is_reexport: true` for `export * from`, `export { x } from`, `export type * from`, `pub use`, `pub(crate) use`, `pub(super) use`, `pub(in path) use`.
2. No test asserts `is_reexport: false` for plain `import`, plain `use`, `from .x import`, `require`.
3. No test counts Aliases edges in the constructed graph (`outcome.graph.count_edges(EdgeKind::Aliases)` style — pattern already exists in indexer tests for References).
4. No test for the A→B→C chain limit (F4) — even a documenting test that asserts the cap would help.
5. No test for the depth>1 asymmetry (F1) — should fail today.
6. No test that a consumer file appears in `def→` results via the re-export hop (F5).

## Confidence
0.8 — Findings F1 and F5 are concrete and reproducible from the patch alone. F2–F4 are design observations grounded in the code as written. F6–F9 are lower-confidence quality notes.
