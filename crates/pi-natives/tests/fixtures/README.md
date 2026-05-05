# CodePath E2E Test Fixtures

This directory contains 13 small source files used by `code_path_e2e.rs` to exercise the NAPI CodePath resolver across all supported dialects. Each fixture is designed to be 10–50 lines and covers key grammar features:

- **TypeScript / TSX**: class, method, arrow function, decorator, JSX component
- **Rust**: struct, impl, trait, `#[test]` function
- **Python**: class, decorator, async def, docstring
- **Go**: package, struct, interface, receiver method, defer
- **Haskell**: function with type signature, guards, where clause
- **HTML**: semantic landmarks, iframe, custom element
- **CSS**: rules, at-rule, custom property, `!important`, vendor prefix
- **Markdown**: ATX headings, frontmatter, fenced code block
- **Org**: TODO state, properties drawer, checkbox
- **Text / JSON / PNG**: basic smoke-test files for bare-path routing

The fixtures are loaded via `env!("CARGO_MANIFEST_DIR")` in the integration test and resolved through `execute_code_path_inner` (NAPI routing layer) or directly via `code_resolver::new()` for qualifier/anchor tests.
