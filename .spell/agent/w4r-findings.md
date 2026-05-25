# W4r Reviewer Findings (PLAN-318)

Reviewed:
- crates/pi-natives/src/code_path/code_resolver/walker.rs (#hover special-case)
- crates/pi-natives/tests/hover_qualifier_e2e.rs

Verdict: correct.

Notes:
- The W4-signature-extract task description called for storing
  signatures in SymbolNode.detail; the existing extractors already
  populate detail. The kernel-level #hover qualifier computes signature
  on-the-fly from tree-sitter, sidestepping the round-trip through
  pi-code-graph. Both paths now coexist cleanly.
- Signature truncation is purely syntactic (stops at `{` / `\n` / `=>`).
  Adequate for common languages; languages with leading attribute lines
  (e.g. Python decorators, Rust attributes) get the bare line which is
  intentional.
