# W1r Reviewer Findings (PLAN-318)

Reviewed:
- crates/pi-natives/src/code_path/edge_dispatch.rs
- crates/pi-natives/src/code_path/code_resolver/walker.rs (line metadata addition)
- crates/pi-code-path/src/parser.rs (trailing-edge synthesis)
- crates/pi-natives/tests/edge_dispatch_e2e.rs

Verdict: correct.

Notes:
- Single-edge MVP is honest: multi-edge chains (e.g. `…def→…call→`) are
  documented as ignored beyond the tail step. Tracked under FUP-093.
- Qualifier on edge results: currently dropped. The dispatcher's
  edge result NodeRefs come from EdgeResolverImpl::nodes cache which
  doesn't re-anchor on tree-sitter, so #body/#sig won't apply
  meaningfully without re-resolving each result. Acceptable for W1.
