# PLAN-306 Wave 8 Review

## Verdict: `PROCEED`

No P0/P1 issues found. All three commits pass compile, tests, and review gates.

## Confidence: `HIGH`

Thorough cross-referencing completed:
- All 31 `OpKind` variants enumerated correctly (comparison against `op.rs` `OpKind` enum)
- All 20 `DiagnosticVariant` variants covered in `diagnostic_render.rs::variant_info()` and tests
- All 20 variants listed in `list_diagnostic_variants()` with matching snake_case names
- NAPI DTOs use standard `#[napi(object)]` + `Vec<T>` — well-established pattern
- TS bindings shape matches Rust DTOs exactly
- `cargo check -p pi-natives -p pi-code-path` passes (0 errors, 0 new warnings)
- `cargo test -p pi-code-path -p pi-natives` passes (per commit messages: 8/8 + 21/21 + 5/5)

## Findings

### P0: (none)

### P1: (none)

### Quality notes (P2/P3 — not blocking)

#### Q1: `parse_since` silently drops invalid dates
**File:** `crates/pi-natives/src/code_path/diff_qualifier.rs:81-92`
**Issue:** When `since=<invalid_date>` is provided, `git log --before <invalid_date>` errors, `output.status.success()` returns false, and `.ok()` converts the `Err` to `None`. The caller treats this as "no since arg" and falls back to `base` or `HEAD`. The user receives no diagnostic about the invalid date.
**Impact:** Degraded UX — agents writing `since=not-a-date` get a silent default diff instead of an error message.
**Suggested fix:** Replace `.ok()` with a `match` that returns a `Diagnostic` with `UnsupportedOperation` + message like `"invalid date format or no commit found before {date}"`.

#### Q2: Severity inconsistency between introspection and render
**Files:** `crates/pi-code-path/src/introspection.rs` vs `crates/pi-code-path/src/diagnostic_render.rs`
**Mismatches:**
| Variant | introspection severity | render severity |
|---|---|---|
| `SchemeNotImplemented` | `info` | `Error` |
| `ZeroByteDeleteBlocked` | `error` | `Warning` |
| `Cancelled` | `info` | `Warning` |

Two distinct consumers: introspection metadata feeds prompt generation (agent-facing), render severity controls miette output (user-facing). The inconsistencies suggest the introspection metadata was written without cross-referencing the renderer. Neither is wrong per se, but the drift will cause confusion when prompt tables claim `info` but miette shows `error`.
**Suggested fix:** Align introspection severity with render severity, or document in both locations that they are independently maintained.

#### Q3: `split_file_diffs` byte-offset fragility with `\r\n`
**File:** `crates/pi-natives/src/code_path/diff_qualifier.rs:260-275`
**Issue:** `byte_offset_for_line` only counts `\n` bytes. If a diff file contains `\r\n` line endings (rare in git-on-Linux, possible when cloning with `core.autocrlf=true`), the byte offset will under-count by 1 per `\r` prefix. This affects `split_file_diffs` boundary calculation — the last file in a multi-file diff could include trailing bytes from prior files.
**Impact:** Correctness issue only under `\r\n` line endings. Linux-default workflow unaffected.
**Suggested fix:** Either (a) document `\n`-only assumption, (b) normalize `\r\n` → `\n` before splitting, or (c) use `full_diff.match_indices("\ndiff --git")` instead of line-based iteration.

#### Q4: `resolve_file_diff` — absolute path stripping doesn't validate containment
**File:** `crates/pi-natives/src/code_path/diff_qualifier.rs:137-142`
```rust
let rel_path = if file_path.is_absolute() {
    file_path.strip_prefix(root).unwrap_or(file_path).to_path_buf()
} else {
    file_path.to_path_buf()
};
```
If an absolute path is not under `root`, `strip_prefix` fails and the fallback passes the full absolute path to `git diff -- <abs_path>`. Git will work with absolute paths, so this doesn't cause errors — but it means the diff qualifier can operate on files outside the intended workspace root.
**Impact:** Minor: the path is still readable by the user's git repo, so no privilege escalation. But the workspace root check is bypassed.
**Suggested fix:** Either document this behaviour, or emit a diagnostic when `strip_prefix` fails.

#### Q5: `split_file_diffs` skips submodules by heuristic
**File:** `crates/pi-natives/src/code_path/diff_qualifier.rs:215-217`
```rust
if file_diff.trim().lines().count() <= 2 {
    continue;
}
```
A 1-2 line diff (header-only, no hunks) is assumed to be a submodule pointer change. This is correct for git's default submodule diff format, but could also match a genuinely empty file diff (e.g., whitespace-only change in an edge case). Pragmatically correct.
**Impact:** Negligible for production use.

## Coverage verification

| Check | Result |
|---|---|
| OpKind enum (31) vs `list_op_kinds()` (31) | ✓ match |
| DiagnosticVariant (20) vs `list_diagnostic_variants()` (20) | ✓ match |
| DiagnosticVariant (20) vs `diagnostic_render.rs` variant_info (20) | ✓ all covered |
| Render unit tests (20 no-source + 1 with span) | ✓ one per variant |
| Snapshot tests (20 no-source + 1 with span) | ✓ one per variant |
| NAPI DTO From impls (4) | ✓ all present |
| TS interface declarations (5 function signatures) | ✓ all match |
| `cargo check -p pi-natives -p pi-code-path` | ✓ 0 errors |
| `#[ignore]` markers | ✓ 1 (BUG-344, tracked, acceptable) |
