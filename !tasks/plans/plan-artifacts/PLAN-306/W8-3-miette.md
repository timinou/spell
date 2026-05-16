# W8-3: Miette Diagnostic Rendering (PLAN-306)

## Summary

Integrated `miette` (v7, `fancy-no-backtrace` feature) into `pi-code-path` so that all 19 `DiagnosticVariant` values render as pretty multi-line errors with error codes, severity indicators (`×` for error, `⚠` for warning), carets, and help text.

## What was done

1. **`Cargo.toml`** — added `miette = { version = "7", features = ["fancy-no-backtrace"] }` as dependency, `insta = { version = "1", features = ["yaml"] }` as dev-dependency.
2. **`src/diagnostic_render.rs`** — new module implementing:
   - `DiagReport` struct implementing `miette::Diagnostic` trait manually with variant-map for code/help/severity
   - `variant_info()` mapping all 19 variants to `(error_code, help_text, severity)`
   - `render_diagnostic()` public function creating `GraphicalReportHandler` with `GraphicalTheme::unicode_nocolor()` (no ANSI codes)
   - Unit tests (20 tests) asserting each variant's code appears in output
3. **`src/types.rs`** — added `impl Diagnostic { pub fn render(&self, source: Option<&str>) -> String }`
4. **`tests/diagnostic_render_tests.rs`** — 21 integration tests (one per variant + source-span rendering) using insta snapshots
5. **`tests/snapshots/`** — 21 snapshot files committed

## Design choice

Single `DiagReport` struct implements `miette::Diagnostic` manually (not via derive) because the diagnostic data is constructed dynamically from the serializable `DiagnosticVariant` enum. This avoids 19 separate error types.

## Sample output

### ParseError (with source span)
```
E_PARSE_ERROR

  × unexpected token at position 5
   ╭─[codepath:1:6]
 1 │ hello @world
   ·      ┬
   ·      ╰── here
   ╰────
  help: Check the CodePath syntax; see the specification for valid grammar
```

### SuffixSuggestion (warning, data-driven help)
```
E_SUFFIX_SUGGESTION

  ⚠ no matches; did you mean `bar`?
  help: Did you mean `bar` instead of `foo`?
```

### AmbiguousTarget (error with count in help)
```
E_AMBIGUOUS_TARGET

  × found 5 matching nodes
  help: Use a more specific path to narrow results; found 5 matches
```

## Test output

```
cargo test -p pi-code-path --test diagnostic_render_tests — 21 passed
cargo test -p pi-code-path — all suite tests pass
cargo check -p pi-code-path — no errors
```

## Commit

```
153c4aded4ee25c7cab757f3bd8cc19fa5f6fa33
feat(pi-code-path): miette diagnostic rendering (PLAN-306 W8.3)
```

Note: The implementation files (`diagnostic_render.rs`, `Cargo.toml` changes, `types.rs` method, `lib.rs` module decl, test file) were committed in a prior concurrent session at `4b9550210` ("chore: more stuff"). This commit adds only the 21 snapshot files required for insta-based testing.
