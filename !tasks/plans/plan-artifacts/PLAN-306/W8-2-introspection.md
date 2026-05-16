# W8.2 — Kernel Introspection NAPI (PLAN-306)

**Commit:** `793b4495b`
**Date:** 2026-05-15

## Summary

Exported 5 kernel introspection functions through NAPI so the JS prompt generator (W10) can render kernel-derived tables without hardcoding.

## Files Created

| File | Purpose |
|------|---------|
| `crates/pi-code-path/src/introspection.rs` | Pure-Rust source-of-truth: 4 list functions + 4 info structs (serde) |
| `crates/pi-code-path/tests/introspection_tests.rs` | Integration tests (5 tests, 1 per function) |
| `crates/pi-natives/src/code_path/introspection_napi.rs` | NAPI bridge: 5 `#[napi]` exports |

## Files Modified

| File | Change |
|------|--------|
| `crates/pi-code-path/src/lib.rs` | Added `pub mod introspection; pub use introspection::*;` |
| `crates/pi-natives/src/code_path/mod.rs` | Added `pub mod introspection_napi;` |
| `packages/natives/src/code-path/types.ts` | Added 5 interfaces + NativeBindings declarations |
| `packages/natives/src/code-path/index.ts` | Added 5 TS wrapper functions |

## Functions

### `listOpKinds() → OpKindInfo[]`
Returns 31 entries, one per `OpKind` variant. Each entry includes:
- `kind`: camelCase name (e.g. `fileCreate`, `symbolReplace`)
- `family`: `"file"` | `"symbol"` | `"line"` | `"css"` | `"heading"`
- `target_shape`: `"path"` | `"path::Symbol"` | `"css"` | `"heading"`
- `required_fields`: Fields the op requires
- `optional_fields`: Fields the op accepts but doesn't require

### `listQualifiers() → QualifierInfo[]`
Returns 11 qualifiers across FS (3) and text (8) dialects:
- FS: `listing`, `tree` (args: `depth=N`), `stat`
- Text: `raw`, `bytes`, `text`, `match`, `captures` (args: `N`), `lines` (args: `a..b`), `image`, `thumbnail` (args: `N`)

### `listEdgeKinds() → EdgeKindInfo[]`
Returns 5 graph edge kinds: `ref→`, `def→`, `call→`, `import→`, `bind→` with name and description.

### `listDiagnosticVariants() → DiagnosticVariantInfo[]`
Returns 20 diagnostic variants with severity (`error`/`warning`/`info`) and canonical message template.

### `listLanguageDialects() → LanguageDialectInfo[]`
Returns all 12 registered languages from `pi_code_engine::LanguageRegistry::with_builtins()`: typescript, rust, python, html, css, typst, markdown, elixir, clojure, edn, org, text. Each entry includes extensions and boolean capabilities (outline, read, navigate, resolve, edit, graph, embed:*).

**Note:** `listLanguageDialects()` is implemented in the NAPI bridge (not `pi-code-path`) because `pi-code-path` cannot depend on `pi-code-engine` (upward dependency).

## Build Verification

- `cargo check -p pi-code-path` — ✅ passes
- `cargo check -p pi-natives` — ✅ passes
- `cargo test -p pi-code-path introspection` — ⚠️ pre-existing `diagnostic_render.rs` compilation failure prevents test execution (unrelated to this change)
- Unit tests are co-located in `introspection.rs` `#[cfg(test)] mod tests {}`

## Known Issues

- Pre-existing test compilation failure in `crates/pi-code-path/src/diagnostic_render.rs` (no `render` method on `Diagnostic` struct) blocks `cargo test -p pi-code-path`. All unit tests in `introspection.rs` are syntactically valid.
