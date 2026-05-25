# W1 Review — Real Findings (PLAN-318 commit 61214d7a1)

## Files reviewed
- crates/pi-natives/src/code_path/edge_dispatch.rs (new, 307 LOC)
- crates/pi-natives/src/code_path/napi.rs (edge dispatch wiring + glob-prefix diag filter)
- crates/pi-natives/src/code_path/code_resolver/walker.rs (metadata.line addition + kind_aliases head match)
- crates/pi-code-path/src/parser.rs (parse_query trailing-edge synthesis)
- crates/pi-natives/src/code_graph_cache.rs (already shipped earlier in W1, verified integration with edge_dispatch)
- crates/pi-natives/src/code_path/edge_resolver/mod.rs (consumer — to confirm contract)
- crates/pi-natives/tests/edge_dispatch_e2e.rs + tests/fixtures/edge_target.ts

## Verdict: **blocking**

Edge dispatch compiles and the e2e tests pass, but the wire-level locator
format produced by `edge_dispatch::to_graph_locator` cannot be matched by
`EdgeResolverImpl::find_node_index`. Every symbol-level edge query falls into
the `FileNotFound` branch and returns an empty result with a graph diagnostic.
The smoke tests do not catch this because they only assert
`!chunks.is_empty()`, and the dispatcher always emits one terminal chunk.

## Findings

### F1 [P0 / blocking] absolute-vs-relative path mismatch breaks every symbol edge query
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:194-220 (`to_graph_locator`)
- severity: blocking
- evidence chain:
  - `code_resolver::walker.rs:148` sets `locator = file.to_string_lossy()` where
    `file` is the **absolute** path passed in from
    `edge_dispatch::resolve` (built via `root.join(&file_node.locator)`).
  - `to_graph_locator` then builds `format!("{}:{}", abs.display(), line)`
    → absolute `"/abs/.../edge_target.ts:5"`.
  - `pi_code_graph::indexer::indexer.rs:113` inserts every `SymbolNode` and
    `FileNode` with `file = relative_path` / `path = relative_path` (relative
    to the workspace root).
  - `EdgeResolverImpl::find_node_index` (edge_resolver/mod.rs:84-130) tries:
    1. exact `qualified_name` — locator is `file:line`, never a qname → miss.
    2. exact `file.path.to_string_lossy() == locator` — relative vs absolute → miss.
    3. `file.path.ends_with(locator)` — `Path::ends_with` is component-wise;
       a path of "edge_target.ts" cannot end-with "/abs/.../edge_target.ts:5" → miss.
    4. `rsplit_once(':')` → `path_part = "/abs/.../edge_target.ts"`,
       compared against `sym.file.to_string_lossy() = "edge_target.ts"` → miss.
  - Result: `Err(FileNotFound: "node not found for locator: …")` pushed to
    `graph_diagnostics`, `results = []`, function returns a single terminal
    chunk with zero nodes.
- fix: in `to_graph_locator`, strip `root` from `abs` so the formatted locator
  matches the graph's relative form, e.g.
  ```rust
  let rel = abs.strip_prefix(root).unwrap_or(&abs);
  copy.locator = format!("{}:{}", rel.display(), line);
  ```
  (Or, symmetrically, teach `find_node_index` to accept either absolute or
  `<canon_root>/<relative>` locators — but the relative-side fix is local and
  keeps the existing unit tests honest.)

### F2 [P0] e2e harness only smoke-checks chunk presence, hiding F1
- file: crates/pi-natives/tests/edge_dispatch_e2e.rs:41-66
- severity: blocking (gates F1)
- The three `*_returns_chunks_without_error` tests assert
  `!chunks.is_empty()` and explicitly discard `first.nodes.len()` with
  `let _ = ...`. The dispatcher always emits at least one terminal chunk even
  on a fully empty result, so these tests succeed for the broken wire above.
  No test asserts:
  - that `def→` from `compute` surfaces `main` as a referrer (the fixture's
    advertised purpose), or
  - that the first chunk has zero `FileNotFound` diagnostics, or
  - that an explicit `def→§call_expression` returns at least one node of that
    kind.
- fix: extend one test to assert `chunks.iter().any(|c| !c.nodes.is_empty())`
  and another to assert no `file_not_found` diagnostic shows up.

### F3 [P1] Outer `cp.qualifier` is silently dropped on edge results
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:73-75, 78-79
- The comment claims qualifiers "re-anchor on the edge result instead —
  handled below," but nothing in the function reads `cp.qualifier` after the
  prefix CodePath is built. A query like `foo.ts::Bar def→#hover` silently
  loses `#hover`; the user gets bare NodeRefs with no diagnostic explaining
  why. Default symbol query path passes the qualifier into
  `code_resolver.resolve`, so this is an asymmetric regression for users
  switching from `…::Bar#hover` to `…::Bar def→#hover`.
- fix: either (a) apply `cp.qualifier` to each `results[i]` via the per-node
  qualifier pipeline used in the default branch, or (b) emit a `Diagnostic`
  with `variant: UnsupportedOperation` when the qualifier is set so callers
  know the qualifier was ignored.

### F4 [P1] Multi-edge chains silently truncated without diagnostic
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:17-22 (comment) +
  189-194 (`split_at_edge`)
- The doc-comment acknowledges "The first Edge consumes the rest of the
  chain; subsequent combinators after the edge tail step are ignored. FUP if
  needed." For a query like `foo.ts::Bar def→§call_expression call→`, the
  trailing `call→` is dropped silently — no diagnostic surfaces to the chunk.
  Users will think the resolver chained two edges and produced a real
  zero-result.
- fix: when `cp.query.chain.len() > edge_pos + 1`, push a diagnostic
  (`UnsupportedOperation` or new `Informational`) describing the dropped
  tail steps before returning. Cheap and prevents silent confusion until
  multi-edge is wired.

### F5 [P1] `Locator::Uri(_) + Edge` silently falls through to walker (no-op)
- file: crates/pi-natives/src/code_path/napi.rs:765-779
- The dispatcher only fires when `cp.locator` is `Locator::Fs(_)`. For
  `Locator::Uri(_)` queries with an edge combinator (e.g. user mistakenly
  writes `'memory://something' def→`), execution falls through to the default
  query path. In `walker.rs:382`, `Combinator::Edge(_)` is unhandled and hits
  the `_ => continue` arm — the candidate list ends empty and the user sees
  zero results with no hint that the edge combinator wasn't honoured.
- fix: in the outer `if let Some(edge_pos)` block, when the locator is not
  `Fs`, emit a one-shot diagnostic
  (`"edge combinators require an Fs locator; got <scheme>://"`) and return,
  rather than silently falling through to the walker.

### F6 [P2] Code-resolver errors during prefix resolution are dropped
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:101-107
  ```rust
  Err(_) => { /* silently skip */ }
  ```
- The default symbol path (napi.rs:832-839) attaches the diagnostic to a stub
  file NodeRef so the user can see *why* a file produced no symbols. Edge
  dispatch swallows it. A query that fails to parse one of N files looks
  identical to one that found no matches — which becomes important when
  combined with F1 (everything silently fails).
- fix: mirror the default branch — push a stub NodeRef carrying the
  diagnostic, or extend `graph_diagnostics` with the per-file error.

### F7 [P2] `filter_by_tail_step` Head::Name branch is a silent no-op
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:228-234
- The comment says "best-effort substring", but the branch returns `nodes`
  unfiltered. A query like `foo.ts::Bar def→Caller` (intending "callers
  named Caller") would not filter at all. Either implement the substring
  filter or emit a diagnostic that name-based tail filtering isn't yet
  supported.

### F8 [P2] `metadata.line` derived from declaration node, not name node
- file: crates/pi-natives/src/code_path/code_resolver/walker.rs:151-156
- The walker emits `node.start_position().row + 1` where `node` is whatever
  matched the step head — for `Head::Name`, this is typically the parent
  declaration node (e.g. `function_declaration`), not the identifier the
  name_lexer matched against. pi-code-graph (e.g.
  `pi-code-graph/src/language/typescript.rs:269,291,311`) records
  `name_node.start_position().row + 1`. For declarations that span newlines
  before the name token (decorators, multi-line `export\nfunction foo`,
  `async\nfn foo`, etc.) the two row numbers diverge and the `file:line`
  locator constructed in F1's `to_graph_locator` will miss even after F1 is
  fixed. Single-line declarations happen to coincide, masking the issue in
  the simple fixture.
- fix: find the matched node's `child_by_field_name("name")` (or the dialect
  anchor) and emit the row of that child instead. Falling back to the
  outer node row is fine when the child can't be located.

### F9 [P3] `let _ = gitignore;` comment is misleading
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:135
- The comment claims "FsResolver consumed it via prefix run" but
  `FsResolver::new` (pi-code-path/src/dialects/fs/mod.rs:36) hardcodes
  `WalkOpts { gitignore: true, hidden: true }`; the `gitignore` parameter
  is never used. This matches the (pre-existing) behaviour of the symbol
  branch in napi.rs:820, so not a regression — but the comment is wrong
  and will mislead the next reader. Drop the comment or wire gitignore
  through.

### F10 [P3] Cold-cache build is synchronous + unbounded
- file: crates/pi-natives/src/code_graph_cache.rs:53-65, called from
  edge_dispatch.rs:114-116
- First edge query on a large workspace blocks the napi task while
  `CodeGraphBuilder::build(...)` walks the tree. There is no cancellation
  point between the walker phase and the build call. `pi_token.is_cancelled()`
  is honoured in the start-node loop above and below, but not while the graph
  is building. Not strictly a W1 regression — graph building was previously
  on no hot path at all — but worth a follow-up since `def→` queries now
  trigger it.

### F11 [P3] code_graph_cache check-then-insert is racy under concurrent first-builds
- file: crates/pi-natives/src/code_graph_cache.rs:57-64
- Two concurrent edge queries against the same cold root will both pass the
  `graphs().get(&canon)` miss, both build, and the second insert overwrites
  the first. No safety issue — `DashMap::insert` is atomic, both `Arc`s are
  valid — but it doubles work on the slow path. Trivial fix: use
  `entry(canon).or_try_insert_with(|| ...)`.

## Coverage gaps
1. No e2e test asserts that `def→`/`call→` actually return nodes from the
   graph (F2). One asserting `chunks[0].nodes.len() >= 1` for
   `edge_target.ts::compute def→` would fail today and force F1.
2. No test exercises the `Locator::Uri(_) + Edge` path (F5).
3. No test exercises multi-edge truncation (F4).
4. No test exercises `qualifier + edge` interaction (F3).
5. No unit test for `to_graph_locator` — would have caught the
   absolute-vs-relative path bug immediately.
6. No test exercising the new walker `kind_aliases` fallback against a real
   dialect (walker.rs:446-456); the change is uncovered.

## Confidence
0.92 — F1 reproduced via static trace through walker → to_graph_locator →
find_node_index against indexer-stored relative paths; smoke test
re-confirmed via `cargo test -p pi-natives --test edge_dispatch_e2e`.
The only uncertainty is whether a path-normalisation layer elsewhere
implicitly relativises before `find_node_index` runs — exhaustive grep over
`pi-natives/src/code_path/` and `pi-code-graph/src/` finds none.
