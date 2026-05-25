# W2 Review — implements→ / inherits→ / dispatches→ edges

Commit reviewed: `7b0f6ecba` (PLAN-318 W2).

## Files reviewed

- `crates/pi-code-path/src/ast.rs` — `EdgeKind` variants + `Display` impl
- `crates/pi-code-path/src/parser.rs` — `edge_kind_p`, trailing-edge synthesis, new heritage_edge_tests
- `crates/pi-code-graph/src/language/typescript.rs` — `collect_heritage_references`, `collect_heritage_from_type` (edge param threading)
- `crates/pi-code-graph/src/language/generic.rs` — `collect_heritage_for_symbol`, `collect_rust_heritage`, `collect_python_heritage`, `extract_type_name`
- `crates/pi-natives/src/code_path/edge_resolver/mod.rs` — `to_graph_edge` mapping for new kinds
- `crates/pi-code-graph/src/model.rs` — confirmed `GraphEdgeKind::{Implements, Inherits, Dispatches}` pre-existing

## Verdict: **needs-fix**

Wiring (parser, resolver mapping, TS edge differentiation, Rust impl extraction) is correct. Python heritage extraction over-extracts and mis-extracts due to a naive `extract_type_name` fallback. Two real bugs ship Inherits edges with wrong / nonsense targets.

## Findings

### F1. Python `metaclass=` and other class-keyword args emit phantom `Inherits` edges  [MEDIUM]

`collect_python_heritage` walks `superclasses.named_children()` and calls `extract_type_name` on every child. In tree-sitter-python the `superclasses` field is an `argument_list`, whose grammar accepts `keyword_argument` (`metaclass=Meta`), `list_splat` (`*bases`), and `dictionary_splat` (`**kwargs`) in addition to plain expressions.

For a `keyword_argument` node, `extract_type_name` hits the `_` fallback at `generic.rs:458-461` and recurses into `named_child(0)`. tree-sitter's `keyword_argument` grammar is `seq(field('name', identifier), '=', field('value', expression))`, so `named_child(0)` is the **keyword name**, not the value. Result: `class X(Base, metaclass=ABCMeta): …` emits `Inherits → "Base"` (correct) **and** `Inherits → "metaclass"` (phantom).

This is common in modern Python (`metaclass=ABCMeta`, `metaclass=ProtocolMeta`, PEP-487 init_subclass kwargs). It pollutes the graph and breaks `who Inherits I?` queries with bogus `metaclass` results.

- File: `crates/pi-code-graph/src/language/generic.rs:418-438` (loop) + `:445-461` (`extract_type_name` `_` arm)
- Fix sketch: in `collect_python_heritage`, skip child kinds that aren't positional base expressions:
  ```rust
  for child in superclasses.named_children(&mut cursor) {
      match child.kind() {
          "keyword_argument" | "list_splat" | "dictionary_splat"
          | "parenthesized_list_splat" => continue,
          _ => {}
      }
      let name = extract_type_name(source, child);
      …
  }
  ```

### F2. Python module-qualified bases (`class X(abc.ABC)`) yield wrong target name  [MEDIUM]

`abc.ABC` parses as a tree-sitter `attribute` node with fields `object` (`abc`) and `attribute` (`ABC`). `extract_type_name`'s `_` arm recurses into `named_child(0)`, which is the **object** (`abc`). Result: `class C(abc.ABC)` emits `Inherits → "abc"` instead of `"ABC"` (or `"abc.ABC"`).

This is the dominant Python convention for ABCs and stdlib bases (`abc.ABC`, `collections.OrderedDict`, `enum.IntEnum`, `typing.Protocol`). Every such class produces a useless edge plus loses the real base, so `inherits→` queries silently miss.

- File: `crates/pi-code-graph/src/language/generic.rs:445-461`
- Fix sketch: add an `attribute` arm that prefers the `attribute` field (or returns the full dotted path):
  ```rust
  "attribute" => node
      .child_by_field_name("attribute")
      .map(|c| extract_type_name(source, c))
      .unwrap_or_default(),
  ```
  And for `subscript` (`Generic[T]`) consider returning the leading value.

### F3. `EdgeResolverImpl::to_graph_edge` — no test asserts new kernel→graph mapping  [LOW / coverage]

The three new arms map `KernelEdgeKind::{Implements, Inherits, Dispatches}` to the graph variants and are syntactically correct, but `crates/pi-natives` has no `to_graph_edge` round-trip test. A future refactor that drops a variant would compile (it's `Option`-returning) and silently regress to "no results" for those kernel queries.

- File: `crates/pi-natives/src/code_path/edge_resolver/mod.rs:138-155`
- Fix sketch: add a small table-driven test that asserts each `KernelEdgeKind` maps to the expected `(GraphEdgeKind, incoming)` pair (including `Bind → None`).

### F4. `dispatches→` is wired through the kernel but no extractor emits `Dispatches`  [LOW / contract gap]

The commit message explicitly defers Clojure/Elixir Dispatches extraction. Kernel parser, resolver and `to_graph_edge` all support it, so `…dispatches→` queries succeed but always return zero results. That is acceptable as an interim contract, but there is no test or comment surfacing this to callers — operators will read it as "no dispatchers found" rather than "no extractor emits this yet". Consider either:
- A `#[ignore]` integration test that documents the empty result, or
- A user-visible diagnostic from `EdgeResolverImpl` when traversing a known-empty edge class.

Not a blocker for W2 since the deferral is explicit in the commit message.

## Non-issues investigated

- **Parser ordering** (`implements` before `import`): the comment is defensive — `winnow`'s literal tag parser is all-or-nothing, so ordering doesn't actually matter for these disjoint literals. Behavior is correct either way.
- **TS `collect_heritage_from_type` recursion**: every branch (`type_identifier`, `generic_type`, `_`) threads the `edge` parameter correctly; the `type_arguments`/`type_parameters` arm deliberately emits `TypeParameterOf` (intentional, unchanged by W2).
- **Rust inherent impl skip**: `child_by_field_name("trait")` returning `None` for `impl Runner { … }` correctly short-circuits before pushing any edge — verified against tree-sitter-rust grammar.
- **Rust scoped/generic trait names** (`impl crate::module::Trait<T> for X`): `extract_type_name` resolves correctly via `scoped_type_identifier.name` and `generic_type.named_child(0)`. tree-sitter-rust's `generic_type` exposes the base under the `type` field, which is the first named child, so the `or_else(named_child(0))` fallback works.
- **TS `extends_type_clause` (interface extends)**: still routed to `Inherits`. Matches prior semantics; existing `heritage_distinguishes_base_from_type_param` test continues to assert the split.

## Coverage gaps

1. No test for Python `class X(Base, metaclass=Meta)` (would catch F1).
2. No test for Python `class X(abc.ABC)` or any dotted base (would catch F2).
3. No test for Python `class X(*bases)` splat / `**kwargs` (F1 variant).
4. No test for Rust `impl !Send for X` (negative impl) — currently still produces `Implements → Send`, may or may not be desired.
5. No `EdgeResolverImpl::to_graph_edge` table test (F3).
6. No end-to-end test (parse `implements→` → resolve → graph hit) in pi-natives.
7. No regression test that `extends` and `implements` simultaneously on the same class produce both edges with the right kinds (the existing `heritage_distinguishes_base_from_type_param` covers it for class but not interface).

## Confidence

0.85 — F1 and F2 are mechanically reproducible from the diff and the upstream tree-sitter grammar; only unverified by a runtime repro. F3/F4 are advisory.
