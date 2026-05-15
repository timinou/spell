# PLAN-306 W9.1: Rust Language Matrix

## Summary

Mirrored `packages/coding-agent/test/codepath/language-matrix.test.ts` at the
kernel level via `MutationResolver` (no JS/NAPI layer). 6 languages × 3 ops
= 18 cells implemented as standalone rust unit tests.

## Files

| File | Action |
|------|--------|
| `crates/pi-natives/src/code_path/language_matrix_tests.rs` | CREATE (590 lines) |
| `crates/pi-natives/src/code_path/mod.rs` | MODIFY (+3 lines: module registration) |
| `!tasks/plans/plan-artifacts/PLAN-306/W9-1-rust-matrix.md` | CREATE (this report) |

## Coverage Matrix

| Language   | Ext   | Op 1                 | Op 2                 | Op 3                    | Status     |
|------------|-------|----------------------|----------------------|-------------------------|------------|
| TypeScript | .ts   | symbolFindReplace¹   | symbolRename         | symbolInsertAfter       | 3/3 ✓      |
| Rust       | .rs   | symbolReplace        | symbolRename         | symbolInsertAfter       | 3/3 ✓      |
| Python     | .py   | symbolReplace        | symbolRename         | symbolInsertAfter       | 3/3 ✓      |
| Markdown   | .md   | headingPromote       | headingDemote        | symbolReplace²          | 3/3 ✓      |
| CSS        | .css  | cssRenameClassToken  | cssRenameIdToken     | cssRenameCustomProp     | 2/3 + 1⛔ |
| HTML       | .html | symbolReplace        | symbolWrap           | symbolInsertAfter       | 2/3 + 1⛔ |

¹ JS test named "symbolReplace" but uses `symbolFindReplace` action internally.
² JS test named "headingReplaceBlock" but uses `symbolReplace` action internally.

**Totals: 16/18 passing (88.9%), 2 ignored (11.1%)**

## Ignored Tests

| Test | Reason | FUP |
|------|--------|-----|
| `css::rename_custom_prop` | kernel rejects token-only rename target; must supply rule-context selector (`:root`) instead of bare token. `CssResolver::build_target_id` falls through to `code_buffer` which expects a selector-formatted `CodePath` target. | FUP-010 |
| `html::symbol_insert_after` | HTML element names (e.g. `section`) resolve via tree-sitter query but the `code_buffer` symbol-resolver does not treat element names as symbol targets. Needs HTML-aware symbol-target handling in the code_buffer edit dispatch path. | FUP-011 |

## Full Suite Results

```
317 passed; 1 failed*; 14 ignored
```

* Pre-existing failure: `clean_tree_returns_empty` — depends on external `git` binary
  availability; unrelated to this wave.

## Commit

```
a1ba9f9d7 test(pi-natives): language matrix (PLAN-306 W9.1)
```
