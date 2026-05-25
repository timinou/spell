# W3 Reviewer Findings — Real (PLAN-318)

## Files reviewed
- `crates/pi-code-graph/src/language/generic.rs` — `resolve_rust_import`,
  `cargo_workspace_member_src`, `swap_underscore_hyphen`,
  `build_cargo_member_map`, `parse_workspace_members`, `parse_package_name`
  (commit `8e1fbb4c2`, lines 1004–1181, tests 1336–1428).
- `crates/pi-code-graph/src/language/typescript.rs` — added regression test
  `typescript_resolver_honours_tsconfig_paths`. Wire was pre-existing.

## Verdict
`needs-fix` — multiple correctness/robustness defects in the hand-rolled TOML
probe. None of them blocks Spell's own repo (single-glob `members =
["crates/*"]`, no `default-members`, no `name.workspace`) but each will
silently break workspace resolution for ordinary downstream layouts.

## Findings

### F1 — `build_cargo_member_map` aborts on first unreadable glob
`generic.rs:1110-1117` — `std::fs::read_dir(&dir).ok()?` short-circuits the
enclosing `Option`. If any glob's directory is missing (typo,
`gitignored`, conditional submodule), the function returns `None` and
`cargo_workspace_member_src` then writes the `unwrap_or_default()` empty map
into the per-process cache. After that point every `use foo_bar::…` in the
project resolves to `None` for the entire daemon lifetime.
Severity: **high**.
Fix: `let Ok(rd) = std::fs::read_dir(&dir) else { continue; };` and emit a
debug log; or accumulate `Result`s and skip rather than `?`.

### F2 — `parse_workspace_members` picks the first "members" substring
`generic.rs:1136-1138` — `after.find("members")` matches `default-members`
because it is a strict substring. A Cargo.toml such as

```toml
[workspace]
default-members = ["crates/cli"]
members         = ["crates/*"]
```

returns `["crates/cli"]` and the rest of the workspace is invisible. The
same defect lets `[workspace.metadata.foo] members-of = …` or any comment
containing the word "members" hijack the parse. The check must require a
word boundary plus `=`, e.g. a line-by-line scan that matches the regex
`^\s*members\s*=`.
Severity: **high**.

### F3 — `parse_package_name` silently skips `name.workspace = true`
`generic.rs:1168-1176` — `line.strip_prefix("name")` accepts the line, but
the next character is `.` so the subsequent `strip_prefix('=')` fails and
the iterator continues. Final result is `None`, so the crate is *never*
inserted into the member map. Workspace inheritance (`name.workspace =
true` with the actual name in `[workspace.package]`) is idiomatic since
Cargo 1.64; any monorepo using it loses cross-crate resolution.
Severity: **medium**.
Fix: when a `name.workspace` entry is seen, fall back to parsing
`[workspace.package] name = "…"` from the root Cargo.toml.

### F4 — Glob coverage limited to a single `*` suffix
`generic.rs:1109` — only `member_glob.strip_suffix("/*")` is treated as a
wildcard. Real-world patterns dropped silently:
- `crates/**` (Cargo expands recursively) → joined as a literal path
  containing `**`, no Cargo.toml read, no crates indexed.
- `crates/*/sub` (used by some plugin layouts) → literal path, miss.
- `./crates/*` works only because `strip_suffix("/*")` keeps the `./`
  prefix which `Path::join` happens to flatten — fragile.
The else-branch `vec![project_root.join(&member_glob)]` swallows the
miss without any signal.
Severity: **medium**.

### F5 — Cache never invalidated; daemon goes stale
`generic.rs:1060-1086` — `OnceLock<Mutex<HashMap<PathBuf, HashMap<…>>>>` is
populated once per `project_root` for the lifetime of the process. The
doc-comment claims "the graph rebuild loop already handles freshness", but
the rebuild loop simply re-enters `resolve_rust_import`, which hits the
same static cache. Renaming a crate, adding a new workspace member, or
flipping `name.workspace = true` requires a daemon restart for the change
to register.
Severity: **medium**. At minimum, key the cache on the
`(project_root, Cargo.toml mtime)` pair, or expose an invalidation hook
that the workspace cache calls on Cargo.toml edits.

### F6 — `[workspace] exclude = […]` ignored
`generic.rs:1098-1133` — excluded directories that still contain a
Cargo.toml are added to the map. For Spell this is harmless because
`brush-core-vendored` is intentionally aliased via `[patch.crates-io]`,
but for general projects an excluded vendored copy of a registry crate
shadows the upstream one in the resolver while Cargo itself uses the
registry version. The resolver and Cargo disagree.
Severity: **low/med**.

### F7 — Single-quoted TOML strings produce broken paths
`generic.rs:1146` — `tok.trim().trim_matches('"').trim()` only strips
double quotes. `members = ['crates/*']` lands in the map as `'crates/*`
(leading single quote remains, trailing `'` stripped by neither call →
`'crates/*'`). The join then targets a nonexistent directory and F1
amplifies the problem to "everything is empty". Same defect applies to
`parse_package_name` (single-quoted names become `'foo-bar'`).
Severity: **low** — uncommon but TOML-legal.

### F8 — Dead/contradictory comment after `return None`
`generic.rs:1041-1045` —
```rust
if segments.is_empty() {
    return None;
    // Bare workspace-member crate name (e.g. `use spell_kernel;`) is rare;
    // fall through.
}
```
The comment promises a fallthrough that the preceding statement makes
unreachable. Either drop the comment or actually implement the fallthrough
(resolve `use spell_kernel;` to the member's `lib.rs`).
Severity: **low**.

### F9 — Test comment contradicts the test
`generic.rs:1378-1384` — the block comment in
`rust_resolver_uses_cargo_workspace_member_src` reads "The `ping.rs`
doesn't exist; the resolver should fall through to none … Neither
exists → None." but the test wrote `crates/foo-bar/src/ping.rs` four
lines earlier and the immediately preceding assertion verifies that
`foo_bar::ping` resolves to that file. The stale comment is left over
from a prior draft and is actively misleading.
Severity: **low**.

### F10 — Mutex poisoning silently disables workspace resolution
`generic.rs:1066, 1083` — both `cache.lock().ok()?` and `if let Ok(mut
guard) = cache.lock()` swallow `PoisonError`. If any path panics inside
the locked section (today none, but future edits are a footgun), the
read path returns `None` for every subsequent call — workspace
resolution silently degrades to the pre-W3 behaviour with no log line.
Severity: **low**.

## Coverage gaps

1. No test exercises **F2's** trigger — a Cargo.toml with both
   `default-members` and `members`. The current fixture writes only
   `members = ["crates/*"]` so the substring shortcut works by accident.
2. No test for **F3** (`name.workspace = true` crate not indexed).
3. No test for **F1** — a workspace whose `members` includes a glob that
   does not yet have a directory (e.g. `["crates/*", "tools/*"]` with no
   `tools/`). Today this silently wipes the map.
4. No test for the `_` vs `-` collision case (both `foo-bar` and `foo_bar`
   present in the same workspace). The current test only verifies the
   one-sided swap (`foo_bar` lookup → `foo-bar` package).
5. No test for `crate::` resolution *inside* a workspace member.
   `resolve_rust_import` still sets `base = project_root/src` for the
   `crate::` branch, so `use crate::Foo` from `crates/consumer/src/main.rs`
   resolves to `project_root/src/Foo.rs` rather than
   `crates/consumer/src/Foo.rs`. W3 fixed cross-crate imports but not
   own-crate imports for workspace members; this asymmetry is not
   documented in the PR.
6. The TypeScript regression test (`typescript_resolver_honours_tsconfig_paths`)
   covers only the happy `compilerOptions.paths` case. No coverage for
   `extends` chains, `baseUrl` without `paths`, or JSONC comments
   (oxc_resolver accepts them; the test does not lock that behaviour).
7. The Python test creates empty `__init__.py` files; it never asserts that
   a missing `__init__.py` (PEP 420 namespace package) is *not* resolved
   the same way. If the underlying candidate list ever drops the `__init__`
   requirement, this test would not catch the regression.

## Confidence
0.78 — All findings traced to specific lines in the patch with concrete
reproduction inputs. Severity calls assume Spell's resolver is intended
to be a general-purpose import probe (per the commit message
"workspace-aware import resolution") rather than a Spell-only helper.
