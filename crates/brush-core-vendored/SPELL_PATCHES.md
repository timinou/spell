# Spell-fork patches to brush-core 0.4.0

This file documents the deliberate divergence between
`crates/brush-core-vendored/` and upstream `brush-core` on crates.io.
Re-apply these on every version bump.

## PATCH-1 (PLAN-310 W5): `WordPreprocessor` hook

### Why
Spell needs URI-like tokens (`skill://x`, `local://y`, etc.) inside bash
commands to resolve to filesystem paths via the kernel's `SchemeRegistry`.
The pre-PLAN-310 design did this with a TS-side regex pre-pass — fragile to
quoting, command-substitution, and escapes. Hooking brush's lexer-aware word
expansion is correct.

### Files touched

```
src/interp.rs   — adds `WordPreprocessor` trait + `word_preprocessor` field
src/expansion.rs — hooks `WordPiece::Text` branch of `expand_word_piece`
src/lib.rs      — re-exports `WordPreprocessor`
```

### Patch shape (`src/interp.rs`)

Added before `pub struct ExecutionParameters`:

```rust
/// Hook for preprocessing word pieces during shell expansion.
pub trait WordPreprocessor: Send + Sync + std::fmt::Debug {
    /// Preprocess one word-piece text. Returns Some(replacement) to claim it; None to defer.
    fn preprocess(&self, text: &str) -> Option<String>;
}
```

Added field to `ExecutionParameters`:

```rust
/// PLAN-310: optional word-piece preprocessor.
pub word_preprocessor: Option<std::sync::Arc<dyn WordPreprocessor>>,
```

### Patch shape (`src/expansion.rs`)

Replaced the `WordPiece::Text(s)` branch in `expand_word_piece`:

```rust
// before
brush_parser::word::WordPiece::Text(s) => {
    Expansion::from(ExpansionPiece::Splittable(s))
}

// after
brush_parser::word::WordPiece::Text(s) => {
    if let Some(pre) = self.params.word_preprocessor.as_ref() {
        if let Some(expanded) = pre.preprocess(&s) {
            Expansion::from(ExpansionPiece::Unsplittable(expanded))
        } else {
            Expansion::from(ExpansionPiece::Splittable(s))
        }
    } else {
        Expansion::from(ExpansionPiece::Splittable(s))
    }
}
```

`Unsplittable` is chosen so substituted paths survive word-splitting (paths
with spaces stay as one argument).

### Patch shape (`src/lib.rs`)

```rust
// before
pub use interp::{ExecutionParameters, ProcessGroupPolicy};

// after
pub use interp::{ExecutionParameters, ProcessGroupPolicy, WordPreprocessor};
```

### Semantic invariants preserved

- Single-quoted text (`'skill://x'`) bypasses the preprocessor — matches bash
  literal semantics.
- Unknown schemes return `None` → fall through to normal expansion.
- Word-preprocessor field defaults to `None`; existing call sites unaffected.

### Test coverage

`crates/pi-natives/tests/brush_scheme_w5.rs` covers the 10-case matrix:
bare token, quoted, command-substitution, redirects, escapes, virtual
rejection, unknown passthrough, plain word passthrough, ExecutionParameters
field carrying, session-aware resolution.

### Re-application strategy

When bumping brush-core, run the test matrix; if any fail, locate the new
expand_word_piece, re-apply the Text-branch hook. The trait + field additions
are forward-compatible.

## Future patches

Document each as `PATCH-N (PLAN-XXX): <title>` with the same structure.
