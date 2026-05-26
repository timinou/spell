# FUP-097 type_resolver.rs review

**Reviewed**: `crates/pi-natives/src/code_path/type_resolver.rs` (757 lines)
**Commit**: `341be0d75` — fold `#hover_inferred` into `#hover` with smart-merge dispatch
**Scope**: `dispatch_hover`, `SourceSelector`, `SemanticPredicates::extract`, `Deprecated`, `format_hover`, `outcome_to_summary`, `StubBackend`

## Concerns assessed and dismissed

| Concern | Verdict | Rationale |
|---|---|---|
| `Option<SourceSelector>` API | Clean | Each qualifier picks its own default; `unwrap_or(Both)` for hover is the single consumer. No scattering. |
| `Deprecated` no span | Unnecessary | Caller has `(file, line, col)` from dispatch args. Replacement hint is sufficient. |
| Deprecated registry for future | YAGNI | Single deprecation; inline match is fine. Revisit when second deprecation added. |
| `format_hover` Single label | Clear | `[source: graph|semantic]` bracket notation is consistent with predicate syntax. |
| Disagreed rendering alignment | Deliberate | `"written:  "` and `"inferred: "` are exactly equal-width (10 chars). Values align at column 11. |
| `severity` unused warning | Not unused | Read at line 220–221 for `#diagnostics` filtering. `SemanticPredicates.severity` is populated unconditionally but only consumed in the diagnostics arm — correct design. |
| StubBackend location | Correct | Local test double in the module that uses it. Moving to `pi-code-graph::semantic` would create wrong-direction coupling and require test-only re-exports in the library. |
| `SourceSelector::parse` change behavior for unrecognized values | Improvement | Old: unrecognized → `Semantic` (silent). New: unrecognized → `None` → `unwrap_or(Both)`. Safer not to interpret garbage as Semantic. |

## Findings

### P3-1: `SourceSelector::or_default` documented but never implemented
**File**: crates/pi-natives/src/code_path/type_resolver.rs:117
**Severity**: P3
**Confidence**: high

**Issue**: The doc comment on `SemanticPredicates.source` says "Callers resolve via [`SourceSelector::or_default`]" but no `or_default` method exists on `SourceSelector`. The only method is `parse`. In practice, `dispatch` at line 209 resolves the default inline: `sp.source.unwrap_or(SourceSelector::Both)`. No caller uses an `or_default` method, so this is purely a doc stale-reference — not a runtime correctness issue.

**Fix**: Either (A) add `pub fn or_default(self, default: Self) -> Self { self.or(default) }` to `SourceSelector` for the documented API, or (B) replace the doc with `// Default resolved per-qualifier inline (e.g. `#hover` → `Both`).` The latter is simpler and avoids adding a method with a single call site.

**Why it matters**: Misleading doc wastes the next developer's time chasing a non-existent API. Low severity because the module is self-contained and the inline resolution pattern is obvious from reading `dispatch`.

---

### P2-2: `dispatch_hover` always probes both backends; "skips LSP cost" claim is false for composite backends
**File**: crates/pi-natives/src/code_path/type_resolver.rs:28, 244–249
**Severity**: P2
**Confidence**: high

**Issue**: Module doc at line 28 says `[source=graph]` — "query Annotation half only (skips LSP cost)". But `dispatch_hover` (line 244) unconditionally calls `backend.hover_dual(file, line, col)`, which in `CompositeSemanticBackend` (composite.rs:145) queries BOTH the Annotation default backend AND the per-extension LSP backend independently. The LSP cost is always incurred; the result is merely discarded by the `source=Graph` filter arm at line 247. The `SemanticBackend::hover_dual` trait method signature takes no `source` parameter, so no backend implementation can honour the short-circuit even in principle.

**Fix**: Three options:
- **(A) Clarify doc**: replace "skips LSP cost" with "uses only the written (graph) half; the inferred half is discarded". Honest about what happens today.
- **(B) Add source to trait**: add `source: SourceSelector` parameter to `SemanticBackend::hover_dual` so `CompositeSemanticBackend` can genuinely skip the LSP query. This is a trait-breaking change across all impls.
- **(C) Add capabilities flag**: `SemanticCapabilities { hover_source_honoured: bool }` — non-composite backends report false; composite reports true. `dispatch_hover` can then short-circuit before calling `hover_dual`.
Recommend (A) now — option (B) or (C) can be a fast-follow P2 perf improvement when the module integrates.

**Why it matters**: Agent using `#hover [source=graph]` to avoid LSP startup latency or flaky server issues still gets hit with the cost. The workaround works (correct answer returned) but the doc promise is broken.

---

### P2-3: `unreachable!` dispatch arm is runtime panic on future qualifier additions
**File**: crates/pi-natives/src/code_path/type_resolver.rs:208–226
**Severity**: P2
**Confidence**: high

**Issue**: `dispatch` first checks `is_semantic_qualifier` (line 203), then switches on the same set of names in a `match` (line 208). The fallthrough arm at line 226 is `_ => unreachable!("is_semantic_qualifier admits exactly these names")`. When a developer adds a qualifier name to `is_semantic_qualifier` (line 93) but forgets to add the corresponding match arm, the result is a **runtime panic** — not a compile error. The two locations must be kept in manual sync. The currently correct state is fragile to future maintenance.

**Fix**: Replace the `is_semantic_qualifier` guard + `match` pattern with a single exhaustiveness-gated approach. Simplest: remove the `is_semantic_qualifier` guard and change `unreachable!` to `return TypeResolverOutcome::NotASemanticQualifier`. The `is_semantic_qualifier` function remains for callers that need pre-flight checks (line 203's early return is fine as an optimisation), but the match fallthrough is safe instead of fatal:

```rust
match qualifier.name.as_str() {
    "hover" => dispatch_hover(...),
    "type_definition" | "type_def" => ...,
    "signature" => ...,
    "inlay" => ...,
    "diagnostics" => ...,
    _ => TypeResolverOutcome::NotASemanticQualifier,
}
```

This preserves the current control flow (the `is_semantic_qualifier` guard above already returns `NotASemanticQualifier` for unknowns) while making the match arm itself non-fatal. If someone adds a name to the function but forgets the arm, the result is a silently-ignored qualifier rather than a panic — which is still a bug but not a crash.

**Why it matters**: Adding a semantic qualifier is the most likely future modification to this module (PLAN-319 W5, new LSP capabilities, etc.). A panic here would surface as a confusing agent-facing error rather than a clean "unrecognised qualifier" fallback. Test coverage of the `unreachable!` path requires an integration test that exercises every qualifier in `is_semantic_qualifier`, which is fragile.

---

## Summary

| Finding | Severity | Confidence | Type |
|---|---|---|---|
| P3-1: `or_default` documented, not implemented | P3 | high | Doc bug |
| P2-2: "skips LSP cost" claim false for composite backends | P2 | high | Doc/code mismatch |
| P2-3: `unreachable!` dispatch arm fragile | P2 | high | Maintenance hazard |

No P0 or P1 findings. All three are introduced in the FUP-097 commit. The smart-merge logic itself (`merge_hover`, `normalise_for_compare`, `CompositeSemanticBackend::hover_dual`) is correct and well-tested. The `SemanticPredicates`, `Deprecated`, and `format_hover` designs are sound. The issues are in documentation accuracy and future-proofing of the dispatch switch.
