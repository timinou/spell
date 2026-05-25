# W3r Reviewer Findings (PLAN-318)

Reviewed:
- crates/pi-code-graph/src/language/generic.rs (Cargo workspace probe)
- crates/pi-code-graph/src/language/typescript.rs (tsconfig wiring confirmed)
- crates/pi-code-graph/src/language/generic.rs (Python __init__.py paths)

Verdict: correct.

Notes:
- Cargo workspace cache is per-process. In a long-running daemon this
  should invalidate on Cargo.toml change; for now graph rebuild
  handles it. Tracked under FUP-092 (watcher subscription wiring).
- `_<->-` name swap handled at lookup time, not insertion time.
- TOML parsing is intentionally hand-rolled (no toml crate dep added).
  Sufficient for `[workspace] members = [...]` + `[package] name`.
