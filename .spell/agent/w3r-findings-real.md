# PLAN-319 W3 Review — type_resolver.rs + parser.rs additions

**Reviewed:** 3be45bedd (W3: CodePath grammar + dispatch to SemanticBackend)
**Files:** `crates/pi-natives/src/code_path/type_resolver.rs` (479 LOC), `crates/pi-code-path/src/parser.rs` (+58 LOC tests), `crates/pi-natives/src/code_path/mod.rs` (+1 LOC)
**Date:** 2026-05-26

---

## Summary

3 findings: 1 P1 (bug), 1 P2 (design gap), 1 P3 (docs). No compilation blockers — all imports resolve correctly against `pi_code_graph` re-exports.

**Verdict: incorrect** — P1 `[source=both]` is a documented feature path that silently returns wrong results. Should be either implemented or gated before merge.

---

## Findings

### F1 [P1] `source=both` documented but not implemented; returns semantic-only

**File:** `crates/pi-natives/src/code_path/type_resolver.rs:123-127`
**Confidence:** 0.95

The module header (lines 18-22) documents `source=both` behavior:
> `source=both` — both consulted; the SemanticBackend answer wins on conflict, with the graph answer surfaced as a secondary chunk.

But the `dispatch` function only checks for `Graph` to short-circuit:

```rust
if matches!(sp.source, SourceSelector::Graph) {
    return TypeResolverOutcome::NotASemanticQualifier;
}
```

`Both` falls through identically to `Semantic` — the graph backend is never consulted. An agent using `[source=both]` silently receives only semantic results, contradicting the documented contract. No test exercises the `Both` path (`dispatch_source_graph_short_circuits_to_lexical_fallback` tests `Graph` only).

**Suggested fix:** Either implement the dual-consultation path (with a new `TypeResolverOutcome` variant carrying both results), or explicitly reject `Both` with a sentinel indicating "not yet implemented" rather than silently degrading to `Semantic`.

---

### F2 [P2] `NotASemanticQualifier` conflates unknown qualifier with `source=graph` redirect

**File:** `crates/pi-natives/src/code_path/type_resolver.rs:123-127`
**Confidence:** 0.90

When `source=graph`, `dispatch` returns `TypeResolverOutcome::NotASemanticQualifier` — the same variant returned for genuinely unknown qualifier names (`body`, `hover`). The caller cannot distinguish:

1. "This qualifier is unknown to the resolver" → caller should try tree-sitter path as-is, likely getting empty results
2. "This IS a semantic qualifier but was explicitly redirected to graph" → caller should compute the graph-side analog (e.g., `#hover_inferred` → `#hover`)

Without this distinction, `find { ::S [source=graph]#hover_inferred }` degrades to the tree-sitter path with an unrecognized qualifier (empty results) rather than falling through to `#hover` on the graph path. A separate variant (e.g., `RedirectedToGraph { qualifier_name: String }`) or a structured field on `NotASemanticQualifier` is needed.

---

### F3 [P3] Module docs omit `type_def` alias

**File:** `crates/pi-natives/src/code_path/type_resolver.rs:1-17`
**Confidence:** 0.85

The module header lists the five semantic qualifiers:
```
//! - `#type_definition` → `backend.type_definition_of(file, line, col)`
```

But both `is_semantic_qualifier` and `dispatch` accept `type_def` as an alias:
```rust
"type_definition" | "type_def" => { ... }
```

The `is_semantic_qualifier_recognises_w3_set` test asserts `type_def` is recognized, which partially mitigates accidental removal. But agents reading the module docs won't discover the alias exists.

**Suggested fix:** Add `#type_def` (alias for `#type_definition`) to the module header documentation.

---

## Concerns analyzed but not reported

### C1: Free-function dispatch (no singleton/registry) — DESIGN NOTE, NOT BUG
The napi call site will need to hold a `&dyn SemanticBackend` reference. The current napi context likely already has a `CompositeSemanticBackend` handle (from KDL config / workspace init). Integration in a later wave can inject the backend ref through the existing napi `execute_code_path_inner` call stack. Not a defect.

### C2: narrow_edge_results no diagnostic for skipped narrowing — KNOWN STUB
The function doc explicitly states "The caller is expected to surface an Informational diagnostic when narrowing was requested but not honoured." The return type (`Vec<SemanticLocation>`) doesn't provide a channel for this. This is acknowledged incompleteness — the stub is deliberate and scoped for later wave.

### C3: outcome_to_summary prefix conventions — UNDOCUMENTED BUT SELF-DOCUMENTING
`~` for Inferred, `?` for Heuristic, no prefix for Annotated, `unknown` for Unknown. These prefixes aren't documented in agent-facing docs, but the behavior is readable from the `format_infer` function and tested in `outcome_to_summary_formats_each_variant`. P3 documentation gap — file for a FUP doc sweep.

### C4: parse_inlay_range clamps negatives — DESIGN CHOICE
`i.max(1)` coerces negative coordinates to 1. This is lenient parsing — `[1..-5]` produces `LineRange { start: 1, end: 1 }` rather than rejecting. Debatable whether this is a bug or intentional lenience. If the CodePath parser can produce negative range values (isize fields on `Predicate::Range`), the resolver should arguably validate and reject rather than silently clamp.

### C5: is_semantic_qualifier allowlist — DRIFT RISK, NOT BUG
Future qualifier additions require updating both the `dispatch` match and the `is_semantic_qualifier` allowlist. Current approach works. Could be mitigated by deriving both from a static `&[&str]` array.

### C6: has_type_aware O(n) — NEGLIGIBLE
Linear scan over predicates. Typical predicate count is < 10. Not worth optimizing.

### C7: napi not wired — ACCEPTED W3 SCOPE
Commit message confirms this is W3-only: dispatch module + tests. End-to-end agent flow is a separate wave task.

### C8: StubBackend test isolation — SAFE
Each test creates its own `StubBackend` instance. `Mutex<Option<LineRange>>` is per-instance. No shared state across tests. Tests are safe for parallel execution.

### C9: narrow_edge_results_consults_backend test — ADEQUATE
The inline `NarrowingBackend` proves the call routes through `backend.narrow_dispatch` when `capabilities().narrow_dispatch` is true. Actual narrowing logic is tested in backend impl tests. Adequate for this module's responsibility.

### C10: SemanticCapabilities vs Capabilities import — CONSISTENT
Test module imports `SemanticCapabilities as Capabilities`. The `StubBackend::capabilities()` returns `Capabilities::default()` (using the trait's associated return path, which resolves through the re-export). The explicit `Capabilities { narrow_dispatch: true, ..Default::default() }` construction in the narrow test uses the local alias. Both paths work; the alias pattern is consistent with how the trait itself names the type.
