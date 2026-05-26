# FUP-097 review: semantic trait + hover_dual + merge

Reviewer: code-reviewer
Scope: `pi-code-graph::semantic::{mod, annotation, composite}` + `pi-natives::type_resolver` StubBackend

---

### P2-1: `hover_dual` default impl — redundant `is_unknown()` guard contradicts `Confidence::Unknown` match arm

**File**: `crates/pi-code-graph/src/semantic/mod.rs:80-91`
**Severity**: P2
**Confidence**: medium

**Issue**: The default `hover_dual` impl has two sequential Unknown checks: an `is_unknown()` early-return (line 82) that catches `Confidence::Unknown + TypeRepr::Empty`, and a `Confidence::Unknown` match arm (line 90) that returns `HoverDual::empty()`. The match arm is reachable only in the malformed case where `confidence == Unknown` but `repr` is non-empty — a condition `InferResult::is_unknown` was deliberately changed (W0g) to NOT treat as unknown, to prevent Composite's `type_at` fallback from dropping useful data.

But the match arm *does* drop it — returning `HoverDual::empty()` and discarding the non-empty repr text. This contradicts `is_unknown()`'s documented philosophy: "a future caller that builds an `InferResult` directly with `confidence: Unknown, repr: Text('…')` doesn't get a false positive that drops useful data."

The two guards disagree on what to do with `Unknown+Text`. In practice this requires a backend bug to trigger, but the inconsistency is confusing to readers and creates a "which one is right?" question for future maintainers.

**Fix**: Remove the `is_unknown()` early-return guard. The `Confidence::Unknown` match arm already handles all Unknown cases (both Empty and non-Empty repr), and the `Annotated`/`Inferred`/`Heuristic` arms handle all meaningful cases. The guard adds no value and creates a contradiction.

```suggestion
fn hover_dual(&self, file: &Path, line: u32, col: u32) -> HoverDual {
    let r = self.type_at(file, line, col);
    match r.confidence {
        Confidence::Annotated => HoverDual { written: Some(r), inferred: None },
        Confidence::Inferred | Confidence::Heuristic => {
            HoverDual { written: None, inferred: Some(r) }
        },
        Confidence::Unknown => HoverDual::empty(),
    }
}
```

**Why it matters**: Inconsistency between two proximity checks for the same condition is a maintenance hazard. A reader skimming `is_unknown()`'s docstring assumes "Unknown+Text is kept through this codebase," then finds the match arm dropping it without comment. The same pattern exists in `StubBackend` (type_resolver.rs:406-416), doubling the maintenance burden.

---

### P2-2: `HoverDual` public fields allow construction bypassing semantic slot contract

**File**: `crates/pi-code-graph/src/semantic/mod.rs:424-427`
**Severity**: P2
**Confidence**: medium

**Issue**: `HoverDual` has public fields (`written: Option<InferResult>`, `inferred: Option<InferResult>`) with no constructor enforcing the semantic contract: `written` should carry `Confidence::Annotated`, `inferred` should carry `Confidence::Inferred`/`Heuristic`. While `merge_hover` degrades gracefully (it only compares repr text, not confidence), callers constructing HoverDual manually can silently mis-route confidence provenance.

Three construction sites bypass the contract:

1. **`dispatch_hover`** (type_resolver.rs:244-245): manually constructs filtered HoverDual for `[source=graph]` / `[source=semantic]` by moving one slot and dropping the other. This is safe because the source selector semantically overrides the slot contract, but a reader must trace both files to confirm.

2. **`StubBackend::with_dual`** (type_resolver.rs:475-542): tests construct HoverDual directly with whatever `InferResult` values they want. A test could accidentally put `Confidence::Inferred` in the `written` slot and the merge would silently produce `Agreed`/`Disagreed` with no indication the slot contract was violated.

3. **Any future backend** that overrides `hover_dual` and constructs `HoverDual { written: Some(r), inferred: Some(r) }` with identical `r` in both slots but wrong confidence.

The current Composite::hover_dual override (composite.rs:144-171) enforces the contract internally via `matches!(...Confidence::Annotated)` / `matches!(...Confidence::Inferred | ...::Heuristic)` gates. But there's no mechanism preventing other code from bypassing those gates.

**Fix**: Add a constructor that enforces the confidence-kind invariant, and make the Composite's gate logic reusable. At minimum, add a `debug_assert`-based constructor:

```suggestion
impl HoverDual {
    pub fn new(written: Option<InferResult>, inferred: Option<InferResult>) -> Self {
        debug_assert!(written.as_ref().map_or(true, |r| matches!(r.confidence, Confidence::Annotated)));
        debug_assert!(inferred.as_ref().map_or(true, |r| matches!(r.confidence, Confidence::Inferred | Confidence::Heuristic)));
        Self { written, inferred }
    }

    pub fn empty() -> Self {
        Self { written: None, inferred: None }
    }
}
```

Alternatively (lower ceremony): add a doc comment on the struct warning that confidence-kind invariants are the caller's responsibility, and reference Composite's `hover_dual` as the canonical constructor pattern.

**Why it matters**: The agent-facing contract ("written = what the user wrote, inferred = what the LSP says") is enforced by convention, not by types. A buggy backend that mis-routes confidence would produce misleading hover output with no error or warning.

---

### P3-3: `StubBackend` fallback duplicates trait default impl — drift risk

**File**: `crates/pi-natives/src/code_path/type_resolver.rs:406-416`
**Severity**: P3
**Confidence**: medium

**Issue**: When `hover_dual_override` is `None`, StubBackend manually reimplements the trait's default `hover_dual` logic (is_unknown guard + confidence match) instead of calling the trait default. If the trait default impl changes (new Confidence variant, different routing logic), the StubBackend fallback silently diverges. Tests using the fallback path won't catch the drift because they test against the StubBackend's own logic, not the trait's.

The StubBackend can't call `Self::hover_dual(self, ...)` because that would recurse into its own override. Rust doesn't provide a "call the default impl" syntax. Workarounds include: (a) move the default logic into a free function both call sites use; (b) add a comment linking the two impls with a "keep in sync" directive; (c) extract the fallback into a helper on a non-overridden method.

**Fix**: Extract the default classification logic into a free function used by both the trait default impl and StubBackend's fallback:

```suggestion
// In mod.rs:
pub fn classify_hover_dual(result: InferResult) -> HoverDual {
    match result.confidence {
        Confidence::Annotated => HoverDual { written: Some(result), inferred: None },
        Confidence::Inferred | Confidence::Heuristic => {
            HoverDual { written: None, inferred: Some(result) }
        },
        Confidence::Unknown => HoverDual::empty(),
    }
}
```

Then both the trait default and StubBackend call `classify_hover_dual(r)`. Removes duplication and eliminates drift risk.

**Why it matters**: Test doubles that silently diverge from production logic produce false confidence. If a new Confidence variant is added, the compiler will catch it in the trait default but NOT in the StubBackend copy, leading to tests that pass but test the wrong behavior.

---

### P3-4: `normalise_for_compare` produces false `Disagreed` for trailing-comma variants in tuple types

**File**: `crates/pi-code-graph/src/semantic/mod.rs:496-506`
**Severity**: P3
**Confidence**: low

**Issue**: The normaliser strips trailing semicolons but not trailing commas. Rust tuple types with trailing commas — `(T, U,)` vs `(T, U)` — are semantically identical but produce different normalised forms: `"(T, U,)"` vs `"(T, U)"`. Since the normaliser preserves token-adjacent whitespace and doesn't strip trailing commas, these normalise to unequal strings, producing `Disagreed` when the types are in fact the same.

This is low-probability: rust-analyzer doesn't typically emit trailing commas in hover, and the Annotation backend reads whatever the user wrote (which may or may not have trailing commas). But for languages where trailing commas are idiomatic in signatures (Python `Tuple[int, str,]`, TypeScript union `'a' | 'b' |`), different backends could produce equivalent-but-not-equal representations.

**Fix**: Strip a single trailing comma (and any whitespace between it and the preceding token) as part of normalisation, mirroring the trailing-semicolon strip:

```suggestion
pub fn normalise_for_compare(s: &str) -> String {
    let trimmed = s.trim()
        .trim_end_matches(';')
        .trim_end_matches(',')
        .trim_end();
    let mut out = String::with_capacity(trimmed.len());
    let mut prev_ws = false;
    for ch in trimmed.chars() {
        if ch.is_whitespace() {
            if !prev_ws { out.push(' '); }
            prev_ws = true;
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out
}
```

**Why it matters**: A spurious Disagreed output tells the agent "these backends disagree" when they don't, reducing trust in the merge and wasting agent attention on a false signal. Low probability but the fix is one line.

---

## Summary

| Finding | Severity | Confidence | Action |
|---------|----------|------------|--------|
| P2-1: Redundant is_unknown guard contradicts match arm | P2 | medium | Remove guard; match handles all |
| P2-2: HoverDual lacks invariant-enforcing constructor | P2 | medium | Add debug_assert constructor or doc |
| P3-3: StubBackend duplicates trait default impl | P3 | medium | Extract classify_hover_dual free fn |
| P3-4: Trailing comma false Disagreed | P3 | low | strip trailing comma in normaliser |

## Verified clean

- Composite's `addr_eq` identity check is correct for the current `Arc<dyn SemanticBackend>` allocation model. The docstring warns about the allocation identity constraint.
- `merge_hover` correctly filters via `is_unknown()` and handles all slot combinations. The Agreed case preserves the written half's original formatting.
- `normalise_for_compare` is idempotent, handles UTF-8 correctly, and correctly preserves paren-adjacency (`foo(x)` ≠ `foo (x)`).
- Composite's capabilities union is intentionally optimistic (best-effort advertising); callers that need per-file precision use `pick(file).capabilities()`.
- Composite's `hover_dual` override correctly queries both backends independently with confidence-kind gating. Silently dropping "wrong" confidence kinds is documented and intentional.
- Annotation backend only produces `Annotated`/`Unknown` — no risk of it triggering the mis-routing guard in Composite's `hover_dual`.
