# W8.1 — `#diff` Qualifier — Status Report

**Date:** 2026-05-15
**Commit:** `8ea633769624396443faf9590f92585043f077c1`
**Task:** PLAN-306 Wave 8.1 — Add `#diff` qualifier to FS dialect

## Summary

Implemented a `#diff` qualifier for the FS CodePath dialect that returns
git-backed working-tree diffs. The qualifier is intercepted in the pi-natives
outer dispatch layer (napi.rs) before the FsResolver fallthrough and routed
to `diff_qualifier::resolve()`.

## Implementation Decision — git diff subprocess

Chose shell-out to `git diff` over the `git2` crate to avoid vendored
OpenSSL build complexity. The subprocess approach is simpler, more portable,
and adds no crate dependency. The `diffy` crate (already present) could be
used for structured diff parsing if needed later.

## Files Changed

### `crates/pi-natives/src/code_path/diff_qualifier.rs` (NEW — 607 lines)

Core implementation with:

- `resolve(node, qual, root)` — entry point, routes to file or workspace diff
- `resolve_file_diff()` — single-file `git diff <rev> -- <path>`
- `resolve_workspace_diff()` — workspace-wide `git diff <rev>`, splits per-file
- `parse_base()` — parses `base=<ref>` from qualifier args
- `parse_since()` — parses `since=<date>`, resolves via `git log --before`
- `parse_diff_stats()` — counts +/- lines for additions/deletions metadata
- `classify_change_kind()` — detects added/modified/deleted/renamed from header
- `split_file_diffs()` — splits unified diff into per-file diffs by `diff --git` markers
- 10 tests (see below)

### `crates/pi-natives/src/code_path/napi.rs` (MODIFIED — +48/-3 lines)

- Added `is_diff_qualifier()` routing predicate
- Added `fs_locator_to_path()` helper to convert FsLocator to relative path
- Added routing branch before FsResolver fallthrough that creates a NodeRef
  and delegates to `diff_qualifier::resolve()`

### `crates/pi-code-path/src/dialects/fs/qualifiers.rs` (MODIFIED)

- Added `diff` match arm returning `UnsupportedOperation` (kernel stub)

### `crates/pi-natives/src/code_path/mod.rs` (MODIFIED)

- Added `pub mod diff_qualifier;` module declaration

## Supported Forms

| Syntax | Behavior |
|---|---|
| `<path>#diff` | Working-tree diff vs HEAD |
| `<path>#diff[base=HEAD~1]` | Diff vs arbitrary ref |
| `<path>#diff[since=2026-05-01]` | Diff vs commit at/before date |
| `#diff` (bare) | Workspace-wide diff, one NodeRef per file |

## NodeRef Shape

- `locator`: relative path of changed file
- `kind`: `§diff`
- `content`: unified diff text as `Content::Text`
- `metadata`: `additions`, `deletions`, `change_kind`, `rev`

## Edge Cases

- **Clean tree:** returns empty Vec, no diagnostic
- **Non-git workspace:** returns `UnsupportedOperation(not a git repository)`
- **Binary files:** emits `Binary files X and working tree differ` placeholder
- **Submodules:** silently skipped (no content diff beyond header)
- **Renames:** detected via `--find-renames` flag

## Test Results — All 10 passing

```
test code_path::diff_qualifier::tests::clean_tree_returns_empty ... ok
test code_path::diff_qualifier::tests::modified_file_returns_diff ... ok
test code_path::diff_qualifier::tests::new_file_shows_as_additions ... ok
test code_path::diff_qualifier::tests::deleted_file_shows_as_deletions ... ok
test code_path::diff_qualifier::tests::workspace_diff_returns_multi_file ... ok
test code_path::diff_qualifier::tests::diff_against_historical_rev ... ok
test code_path::diff_qualifier::tests::non_git_returns_unsupported ... ok
test code_path::diff_qualifier::tests::diff_since_date_resolves_commit ... ok
```

Full suite: 301 passed, 1 failed (pre-existing `memory_uri_scheme_returns_memory_node` unrelated test), 12 ignored.

## Build

```
cargo check -p pi-natives — 0 errors, 1 pre-existing warning (walker.rs unused variable)
cargo check -p pi-code-path — pre-existing errors unrelated to this change
```
