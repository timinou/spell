# W2r Reviewer Findings (PLAN-318)

Reviewed:
- crates/pi-code-path/src/ast.rs (EdgeKind expansion)
- crates/pi-code-path/src/parser.rs (edge_kind_p ordering)
- crates/pi-code-graph/src/language/typescript.rs (extends/implements split)
- crates/pi-code-graph/src/language/generic.rs (rust impl / python class heritage)
- crates/pi-natives/src/code_path/edge_resolver/mod.rs (kernel→graph mapping)

Verdict: correct.

Notes:
- Rust inherent impls correctly skipped (no Implements edge for `impl X { ... }`).
- Python superclass walk handles type expressions via extract_type_name's
  generic_type / scoped_type_identifier fallback.
- Clojure/Elixir polymorphic Dispatches deferred to FUP-093 - those need
  language-specific defprotocol/defimpl/extend-type reasoning.
- Parser arrow-token ordering: longer prefixes first (implements before
  import) prevents accidental partial matches.
