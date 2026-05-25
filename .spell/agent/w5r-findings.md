# W5r Reviewer Findings (PLAN-318)

Reviewed:
- crates/pi-code-graph/src/language.rs (ExtractedImport.is_reexport)
- crates/pi-code-graph/src/language/typescript.rs (export-from flag)
- crates/pi-code-graph/src/language/generic.rs (pub use detection)
- crates/pi-code-graph/src/indexer.rs (Aliases edge emission)
- crates/pi-natives/src/code_path/edge_resolver/mod.rs (neighbours_with_reexport)
- crates/pi-natives/tests/reexport_e2e.rs

Verdict: correct (with documented bounded scope).

Notes:
- One-hop transitive re-export following only. Re-export chains of
  depth >1 are not followed; this is intentional to avoid result
  blow-up and stays consistent with depth=1 default for def→.
- Aliases edges are emitted at file→file granularity. Future symbol-
  level granularity (which specific re-exported names) can layer on
  top without breaking the kernel API.
- Rust `pub use` detection handles `pub`, `pub(crate)`, `pub(super)`,
  `pub(in path)` visibility forms.
