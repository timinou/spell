# FUP-097 Review: Unified Edit Surface

Reviewer: `unified-edit` (template + dispatch + FUP-097 SemanticReadOnly)

---

### P2-1: `#hover` treated as editable Symbol target — misleading doc comment
**File**: crates/pi-code-path/src/unified.rs:106-108
**Severity**: P2
**Confidence**: medium

**Issue**: The doc comment on `read_only_semantic_qualifier` claims `#hover` "describe[s] the signature region of a symbol, which IS a valid edit scope." This conflates `#hover` (hover/type info, smart-merge of graph + LSP) with `#sig` (textual signature region). `#hover` is fundamentally a read-side inspection qualifier — it returns hover type info, docs, and optionally a written signature. When an agent uses `replace` on a `#hover` target, the classifier maps it to `TargetShape::Symbol` and dispatch produces a whole-symbol replacement. The agent asked for hover info; silently substituting a whole-symbol overwrite is surprising and conflates inspection with mutation.

**Fix**: Either add `"hover"` to `read_only_semantic_qualifier` (consistent with the find.md prompt's stated intent that semantic qualifiers are read-only views), or update the comment to accurately reflect that `#hover` dispatches to whole-symbol edit scope as a deliberate affordance. The current comment is factually wrong — `#hover` does not "describe the signature region" the way `#sig` does.

**Why it matters**: An agent that chains `find { …#hover }` (inspection) → `replace` (mutation) on the same CodePath gets a silent behaviour change — whole-symbol replacement instead of an informative error. The find tool prompt (find.md:109) explicitly states read-only semantic qualifiers cannot be edit targets, but `#hover` is excluded from that list, creating inconsistency between documentation and semantics.

---

### P2-2: Misleading `$LAST` hint when node has 0 named children
**File**: crates/pi-code-path/src/template.rs:74-75
**Severity**: P2
**Confidence**: high

**Issue**: `expand_last` errors via `pos_out_of_range(1, 0)` when the matched node has zero named children. But `pos_out_of_range` returns a static hint: "Use $MATCH for the full matched text, or $LAST for the last child." When `$LAST` itself just failed due to 0 children, recommending `$LAST` again is circular and misleading. The agent following this advice would retry `$LAST` and get the same error.

**Fix**: Parameterise the hint based on context. For `$LAST` failures with 0 children, the hint should say "Use $MATCH for the full matched text." For positional `$N` failures, the existing hint is fine. Add a separate error constructor or a boolean parameter to `pos_out_of_range`:
```rust
fn pos_out_of_range(requested: usize, available: usize, is_last: bool) -> Self {
    let hint = if is_last && available == 0 {
        "Use $MATCH for the full matched text.".into()
    } else {
        "Use $MATCH for the full matched text, or $LAST for the last child.".into()
    };
    // ...
}
```

**Why it matters**: Agent self-correction loops — the agent sees the hint, retries `$LAST`, gets the same error, wastes turns. Particularly likely when the agent targets a leaf node (e.g. an identifier with no children) and tries `$LAST`.

---

### P3-3: Double-call pattern + misleading `&'static str` return in `read_only_semantic_qualifier`
**File**: crates/pi-code-path/src/unified.rs:114-124, 145-147
**Severity**: P3
**Confidence**: high

**Issue**: `read_only_semantic_qualifier` returns `Option<&'static str>` but always returns `Some(input_string)` — it never transforms or enriches the value. The `&'static str` return type suggests a lookup that maps input → different output (e.g. normalising aliases), but no such mapping exists. Call site then performs the lookup twice: once in the guard (`if read_only_semantic_qualifier(name).is_some()`) and once to unwrap (`qualifier: read_only_semantic_qualifier(name).unwrap()`).

**Fix**: Simplify to `fn is_read_only_semantic_qualifier(name: &str) -> bool`. In the classifier, bind the name directly:
```rust
(false, true, Some(name)) if is_read_only_semantic_qualifier(name) => {
    TargetShape::SemanticReadOnly { qualifier: name }
},
```
The `qualifier` field in `SemanticReadOnly` should then be `&str` (lifetime tied to CodePath) rather than `&'static str`, since the name comes from the parsed qualifier, not a static string. If the `&'static str` is wanted for zero-copy, keep the match-as-lookup but call once via `if let` binding.

**Why it matters**: Code smell — the double-lookup suggests intent (transformation/aliasing) that isn't implemented. Future maintainers might add an alias and break the double-call pattern (first call normalises, second call returns un-normalised string at a different index).

---

### P3-4: Duplicate guard pattern across three dispatch functions
**File**: crates/pi-code-path/src/unified.rs:186, 260, 290
**Severity**: P3
**Confidence**: high

**Issue**: All three dispatch functions (`dispatch_replace`, `dispatch_rename`, `dispatch_delete`) open with the identical guard:
```rust
if let TargetShape::SemanticReadOnly { qualifier } = shape {
    return Err(read_only_semantic_diagnostic("replace", qualifier));
}
```
Three copies of the same logic. Adding a new read-only qualifier or changing the diagnostic format requires touching all three.

**Fix**: Extract to a shared early-return helper:
```rust
fn reject_read_only(shape: TargetShape, action: &str) -> Result<(), Diagnostic> {
    if let TargetShape::SemanticReadOnly { qualifier } = shape {
        Err(read_only_semantic_diagnostic(action, qualifier))
    } else {
        Ok(())
    }
}
```
Each dispatch function becomes:
```rust
reject_read_only(shape, "replace")?;
```

**Why it matters**: DRY violation — future divergence (e.g. rename gets a different hint than replace) could happen unintentionally. Low risk now, but the pattern invites copy-paste drift.

---

### P3-5: Hint message syntax discrepancy with find tool grammar
**File**: crates/pi-code-path/src/unified.rs:107-108
**Severity**: P3
**Confidence**: medium

**Issue**: The diagnostic says `find { … #qualifier }` but the actual find tool syntax requires `find { target: "file::sym#qualifier" }`. The `…` ellipsis is ambiguous — the agent might try `find { foo.ts::bar#hover_inferred }` (missing `target:` field) or `find { target: "… #hover_inferred" }` (literal ellipsis). The find tool prompt (find.md) consistently uses `find { target: "…" }` with the full CodePath inside the target string.

**Fix**: Use a concrete example or the standard `target:` field syntax:
```
Use `find { target: "file::sym#hover_inferred" }` to inspect it.
```
Or more practically, since the file/symbol are known at the call site:
```rust
fn read_only_semantic_diagnostic(action: &str, qualifier: &str, cp: &CodePath) -> Diagnostic {
    // Could format the actual CodePath without the qualifier
}
```

**Why it matters**: If the agent blindly follows the hint, it gets a parse error from the find tool, wastes a turn, and may not self-correct. Low severity because the agent typically has enough context to infer the correct syntax, but the `…` is particularly confusing for models that treat it as literal text.
