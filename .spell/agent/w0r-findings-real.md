# W0R-1: BM25 Incremental + Schema Bump

## [P2] upsert_batch "last occurrence wins" contract silently violated when last entry is empty

**File:** `crates/pi-knowledge-core/src/bm25.rs:123-128`
**Why it's wrong:**
The doc comment for `upsert_batch` states: *"duplicate ids within `docs` cause the last occurrence to win"*. But the implementation uses `let _ = self.upsert_doc(doc);` — when the last occurrence is an empty document, `upsert_doc` returns `Err(IndexError::EmptyDocument)`, which is silently swallowed. The non-empty predecessor survives, contradicting "last wins." No test covers this edge case (the batch-equals-loop test in I4 uses non-empty docs with unique IDs).

**Suggested fix:**
Either (a) change the contract to "last *valid* occurrence wins" and add a note, or (b) if the user calls upsert_batch with `[doc("X","alpha"), doc("X","")]`, the intent is arguably to keep "alpha" (since an empty doc can't replace anything). Option (a) is simpler and matches current behavior. Add a test:

```rust
#[test]
fn upsert_batch_last_empty_does_not_erase_predecessor() {
    let mut idx = SearchIndex::default();
    idx.upsert_batch(vec![doc("a", "alpha"), doc("a", "   "), doc("a", "beta")]);
    // The empty doc is skipped; beta survives as last non-empty occurrence.
    let hits = idx.search("beta", 5);
    assert_eq!(hits.first().map(|h| h.doc_id.as_str()), Some("a"));
    // Verify alpha is gone (replaced by beta).
    assert!(idx.search("alpha", 5).is_empty());
}
```

---

## [P2] I6 term_doc_freq invariant test only covers add→remove; upsert paths not validated

**File:** `crates/pi-knowledge-core/src/bm25.rs:612-631`
**Why it's wrong:**
The I6 test exercises term_doc_freq consistency after `add_doc` then `remove_doc`. It does not cover: (a) `upsert_doc` replacing a doc — which calls `remove_doc` then `insert_validated`, where overlapping terms between old and new doc must net-zero correctly; (b) `upsert_batch` with duplicates where removal and re-insertion for the same ID interleave; (c) `compact` which must not alter term_doc_freq. I9 validates score parity (which depends on term_doc_freq), but the df counts themselves could drift in ways that cancel out in certain query patterns.

**Suggested fix:**
Add a focused invariant test that verifies term_doc_freq via recomputation after a churn sequence involving upserts:

```rust
#[test]
fn i6b_term_freq_invariant_after_upsert_churn() {
    let mut idx = SearchIndex::default();
    idx.add_doc(doc("a", "alpha beta")).unwrap();
    idx.add_doc(doc("b", "beta gamma")).unwrap();
    // upsert replaces "a" with a doc sharing "beta" but dropping "alpha"
    idx.upsert_doc(doc("a", "beta delta")).unwrap();
    // Recompute from live docs
    let mut expected: BTreeMap<String, u32> = BTreeMap::new();
    for doc in idx.docs.iter().filter_map(Option::as_ref) {
        for term in doc.frequencies.keys() {
            *expected.entry(term.clone()).or_default() += 1;
        }
    }
    assert_eq!(idx.term_doc_freq, expected);
    // "alpha" was unique to old doc-a → must be pruned
    assert!(!idx.term_doc_freq.contains_key("alpha"));
    // "beta" in both b and new a → count = 2
    assert_eq!(idx.term_doc_freq.get("beta"), Some(&2));
}
```

---

## [P2] remove_doc uses saturating_sub for counters, silently masking invariant drift

**File:** `crates/pi-knowledge-core/src/bm25.rs:128-140`
**Why it's wrong:**
`remove_doc` uses `saturating_sub` for `total_tokens`, `live_count`, and each `term_doc_freq` entry. This is described as defensive, but under the documented invariants these subtractions should never underflow. If a bug is introduced that causes, e.g., double-removal of a doc, the saturating arithmetic silently produces wrong state (`total_tokens` stuck at 0, `live_count` stuck at 0, df counts stuck at 0) rather than surfacing via panic or debug_assert!. The test suite can't detect invariant violations if the runtime masks them.

The `docs[*] = None` guard (lines 130-138) already handles double-removal by returning `false`, so the counts are never hit in that path. The risk is limited to future refactors that bypass the `slot.take()` check.

**Suggested fix:**
Replace `saturating_sub` with plain `-` and add `debug_assert!` that the result is non-negative, or keep saturating but add:

```rust
debug_assert!(
    doc.tokens.len() as u64 <= self.total_tokens,
    "remove_doc: total_tokens underflow for doc {}",
    id
);
```

This preserves the defensive runtime behavior while catching bugs in debug/test builds.

---

## [P3] insert_validated updates id_to_index before populating docs[idx], momentarily violating documented invariant

**File:** `crates/pi-knowledge-core/src/bm25.rs:244-251`
**Why it's wrong:**
The doc-comment invariant states: *"id_to_index[id] == i ⇒ docs[i] = Some(d) ∧ d.doc_id == id"*. In `insert_validated`, `id_to_index.insert(doc.doc_id.clone(), idx)` runs on line 250, then `self.docs[idx] = Some(doc)` on line 251. Between these two statements, `id_to_index` points to a `None` slot. This is safe under `&mut self` (no concurrent access), but if `id_to_index.insert` were swapped with `self.docs[idx] = Some(doc)`, the invariant would never be broken even momentarily. The current order is a latent footgun for any future code that reads `docs[id_to_index[id]]` during an intermediate state (e.g., if a `?` operator or early-return is later inserted between the two lines).

**Suggested fix:**
Swap the two lines so `docs[idx]` is set before `id_to_index` is updated:

```rust
fn insert_validated(&mut self, doc: SearchDocument) {
    let idx = self.allocate_slot();
    self.total_tokens += doc.tokens.len() as u64;
    self.live_count += 1;
    for term in unique_terms(&doc.frequencies) {
        *self.term_doc_freq.entry(term).or_insert(0) += 1;
    }
    self.docs[idx] = Some(doc);  // set slot first
    // SAFETY: idx was allocated above; doc is owned.
    // `docs[idx]` is Some(...). Now wire up the lookup.
    let doc_id = self.docs[idx].as_ref().unwrap().doc_id.clone();
    self.id_to_index.insert(doc_id, idx);
}
```

This ensures the invariant holds at every observable program point.

---

## [P3] upsert_doc clones doc_id unnecessarily in the replace path

**File:** `crates/pi-knowledge-core/src/bm25.rs:112-115`
**Why it's wrong:**
`upsert_doc` calls `let id = sd.doc_id.clone();` and then only uses `&id` for `contains_key` and `remove_doc`. Since `remove_doc(&str)` and `contains_key(&str)` take references, the clone is redundant — `&sd.doc_id` would suffice. While the `sd` is later moved into `insert_validated(sd)`, `sd.doc_id` still lives as local until moved. This is a minor allocation overhead, not a correctness issue, but the pattern appears intentional and warrants a note.

**Suggested fix:**
Replace with:

```rust
if self.id_to_index.contains_key(&sd.doc_id) {
    self.remove_doc(&sd.doc_id);
}
self.insert_validated(sd);
```

---

## Confirmed-correct items (no finding needed)

### Schema bump completeness
`KNOWLEDGE_SCHEMA_VERSION: 1 → 2` in `crates/pi-knowledge-core/src/cache.rs`. The `purge_if_stale` gate in `crates/pi-knowledge-core/src/ingest.rs` reads `KnowledgeMeta` before any heavy blob is loaded. `KnowledgeMeta::status_against` checks `schema_version != KNOWLEDGE_SCHEMA_VERSION` first. This correctly prevents v1 `bm25.bin` files (with `Vec<SearchDocument>` shape) from being decoded against the v2 `Vec<Option<SearchDocument>>` struct. No other cache entry types (`GraphCacheEntry`, `OrgIndexEntry`) embed `SearchIndex` — they only need bumping when their own fields change. ✓

### bincode shape compatibility
`Vec<Option<SearchDocument>>` (v2) differs from `Vec<SearchDocument>` (v1) by an `Option` discriminant byte per element. A v1 blob decoded as v2 would misalign on the first SearchDocument field. The meta.bin gate prevents this entirely — `purge_if_stale` reads meta.bin first and, on schema version mismatch, deletes the entire cache directory before any blob load is attempted. ✓

### I9 parity test tightness
The 1e-5 epsilon is adequate: both paths use identical floating-point operations on identical `SearchDocument` data. TF, IDF, norm, and boost are bit-identical when docs match, making the epsilon conservative. The `BTreeMap<(doc_id, score)>` comparison avoids tie-order false positives. ✓

### Sort tie-break extension
Adding `doc_id` as tertiary key (score → label → doc_id) replaces the previous iteration-order-dependent tie-breaking. This is a correctness improvement, not a behavioral regression. The old order was undefined (depended on `Vec` position, which changed under tombstone reuse); the new order is deterministic across all mutation sequences. Documented in `compact()`'s doc comment. ✓

### I7 bincode roundtrip
The test serializes, deserializes, and verifies all fields (`doc_count`, `total_tokens`, `id_to_index`, `term_doc_freq`, `capacity`, search results). Tombstone-bearing state (remove "b" from [a,b,c], add "d" which reuses slot) is preserved. ✓

### upsert_doc atomicity (validates-before-mutating)
`SearchDocument::build(&doc)?` runs first. On `EmptyDocument`, the `?` returns before `remove_doc` is reached. The old entry is untouched. The `upsert_doc_validates_before_mutating` test pins this. ✓

### id_to_index consistency
`remove_doc` removes from `id_to_index` before clearing the slot. `insert_validated` inserts into `id_to_index` after allocating the slot but before populating (→ P3 finding above). `compact` rebuilds `id_to_index` from scratch. Cross-mutation: remove-then-add reuses the tombstoned slot and updates `id_to_index` correctly. ✓

### compact() search result preservation
I8 verifies: insert 10, remove 4, search, compact, search again — same doc ID set, same score order, reduced capacity. The doc comment correctly notes tie-order dependence on iteration position (mitigated by the doc_id tiebreaker). ✓

### KnowledgeMeta gate path
Flow: `ensure_warm` → `build_warm` → `try_load_warm` → `purge_if_stale` → `KnowledgeMeta::status_against`. Schema v1 meta.bin → `CacheStatus::Stale` → directory removed → fall through to `full_rebuild`. No `bm25.bin` loaded without meta approval. ✓

# W0R-2: BM25 Dedup + Adapter

## [P2] `pi_code_graph::SearchIndex` re-export breaks type identity

**File:** `crates/pi-code-graph/src/lib.rs:36`
**Why it's wrong:**
The old `pub use search::{SearchHit, SearchIndex}` exported `crate::search::SearchIndex` — a local struct with fields `docs: Vec<SearchDocument>`, `avg_doc_len: f32`, `term_doc_freq: BTreeMap<String, usize>`. The new `pub use pi_knowledge_core::bm25::SearchIndex` exports a structurally different type with fields `docs: Vec<Option<SearchDocument>>`, `id_to_index: BTreeMap<String, usize>`, `total_tokens: u64`, `live_count: u32`, `term_doc_freq: BTreeMap<String, u32>`. Any external consumer that type-checks against the old concrete `pi_code_graph::SearchIndex` (e.g., storing it in a struct field, pattern-matching on its shape, or calling deprecated methods like `build()`) would get a compile error. Internal consumers (`pi-natives`, `pi-knowledge-worker`) import `pi_knowledge_core::bm25::SearchIndex` directly and are unaffected. The `SearchHit` re-export is structurally identical (same four fields, same types) and backward-compatible.

**Suggested fix:**
Add a type alias for migration soft-landing, then remove in W1+1:
```rust
#[deprecated(since = "W0", note = "Use pi_knowledge_core::bm25::SearchIndex directly")]
pub type SearchIndex = pi_knowledge_core::bm25::SearchIndex;
```
Or document the breaking change in the W0 changelog if no external consumers exist. The old `search::SearchIndex::build()` method (took `&PersistedCodeGraph`) is replaced by `bm25_adapter::build_search_index()`, so callers already need migration.

---

## [P3] No test validates BM25 correctness after `PersistedCodeGraph` serde round-trip

**File:** `crates/pi-code-graph/src/bm25_adapter.rs:119-199` (test module)
**Why it's wrong:**
The adapter test `bm25_prefers_exact_symbol_match` builds a `PersistedCodeGraph` directly from an inline `StableGraph` and indexes it. It never serializes+deserializes the `PersistedCodeGraph` before building the search index. Since `StableGraph::node_indices()` iteration order is insertion-order and serde preserves slot order, this works correctly. However, no test validates that `to_index()` values are stable across a bincode round-trip of the persisted graph — the `node_index` values embedded as `doc_id` strings in the BM25 index would silently desync from the deserialized graph's `from_index` mapping if petgraph ever changed its serde representation. A regression here would manifest as all search hits being silently filtered out (downgraded to empty results rather than panics, making it hard to detect).

**Suggested fix:**
Add a round-trip test:
```rust
#[test]
fn doc_ids_survive_graph_roundtrip() {
    // Build graph, index it, serialize graph, deserialize, rebuild index, verify same hits
    let mut graph = StableGraph::<GraphNode, EdgeKind>::new();
    graph.add_node(GraphNode::Symbol(SymbolNode {
        name: "Foo".into(), qualified_name: "src/lib.rs::Foo".into(),
        file: PathBuf::from("src/lib.rs"), kind: SymbolKind::Function,
        exported: true, line: 1, column: 1, detail: None,
    }));
    let persisted = PersistedCodeGraph {
        root: PathBuf::from("."), graph, stats: GraphStats::default(),
        generated_at_ms: 0, git_head: None,
    };
    let index = build_search_index(&persisted);
    let before = bm25_search_adapted(&persisted, &index, "Foo", 5);
    assert_eq!(before.len(), 1);

    // Round-trip PersistedCodeGraph through bincode
    let encoded = bincode::serialize(&persisted).unwrap();
    let decoded: PersistedCodeGraph = bincode::deserialize(&encoded).unwrap();
    let index2 = build_search_index(&decoded);
    let after = bm25_search_adapted(&decoded, &index2, "Foo", 5);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].label, before[0].label);
}
```

---

## [P3] `resolve_hit` reconstructs `path` from graph but discards `label` from BM25 index — unnecessary coupling

**File:** `crates/pi-code-graph/src/bm25_adapter.rs:104-117`
**Why it's wrong:**
`resolve_hit` sets `label: hit.label` (from the BM25 index's stored label) and `path` (from the graph node's `file.path` or `symbol.file`). The label is already correct from the index — no graph lookup needed for it. However, callers in `query.rs::graph_search` re-derive both `label` and `path` via `summary_for_node(graph, node_index)`, discarding the `SearchHit.label` and `SearchHit.path` entirely. The `path` lookup in `resolve_hit` is wasted work for the `graph_search` code path. This isn't a bug — the `SearchHit` type is a public API consumed by `hybrid.rs` which does use `.label` and `.path` — but the comment in the adapter suggests "so callers can navigate without re-tokenising the label" when in fact the primary caller does re-derive everything. The performance cost is small (O(1) hashmap lookup per hit), but the intent mismatch is confusing.

**Suggested fix:**
Clarify the doc comment on `SearchHit` to note that `hybrid.rs` uses `label`/`path` directly while `query.rs` re-derives via `summary_for_node` for consistency with its `GraphNodeSummary` output type. No code change needed.

---

## Confirmed-correct items (no finding needed)

### doc_id = node_index.to_string() — no collision risk
`petgraph::StableGraph::to_index` returns `ix.index()` — the internal `usize` slot. StableGraph never reuses indices after `remove_node`. Two distinct live `GraphNode`s can never share the same `to_index()` result. Dead nodes' indices are included in `node_indices()` but `node_weight()` returns `None` for them, so `build_search_index`'s `?` filters them before they enter the BM25 index. If bincode corruption injects a stale doc_id, `resolve_hit` → `from_index` → `node_weight` → `None` → `?` correctly filters it. ✓

**Citation:** `petgraph-0.8.3/src/graph_impl/stable_graph/mod.rs:2332-2334` — `from_index` creates `NodeIndex::new(ix)` (infallible). `node_weight` (line 648) uses `self.g.nodes.get(a.index())` → `Option<&N>`. Removed nodes have `weight: None` in the Node entry; live nodes have `weight: Some(N)`. No panic path.

### resolve_hit parse safety
`doc_id` is always `node_index.to_string()` — decimal representation of a `usize`. `.parse::<usize>().ok()?` always succeeds in normal operation. The `.ok()?` is correct defense-in-depth against bincode corruption; silently dropping is appropriate (no diagnostic needed for data that can only be corrupted by external tampering or filesystem error). ✓

### build_search_index iteration order stability
`node_indices()` iterates `self.g.nodes.iter().enumerate()` — insertion order. Serde for `StableGraph` serializes nodes in array order, preserving slot positions. `to_index()` returns the slot index, which is stable under serialization because the serde impl preserves the position of each `Node` entry in the `nodes` vec. ✓

### Lifetime soundness of bm25_search
`CodeGraph::bm25_search(&self, ...)` borrows `&self.persisted` and `&self.search_index` simultaneously — both shared references from the same `&self`. `bm25_search_adapted` calls `index.search(query, limit)` which returns owned `Vec<bm25::SearchHit>`, then `.into_iter().filter_map(|hit| resolve_hit(persisted, hit))` — `resolve_hit` borrows `persisted` immutably. No borrow conflict: `index.search` releases its borrow before `resolve_hit` runs. The compiler accepts this pattern. ✓

### from_index out-of-range defense
`from_index` creates `NodeIndex::new(ix)` without bounds check. `node_weight` uses `Vec::get(a.index())` → `Option`. Out-of-range `usize` → `node_weight` returns `None` → `resolve_hit` returns `None` → filtered. Does not panic. The `unresolvable_hits_filtered` test validates this explicitly with an empty graph and doc_id "9999". ✓

### search.rs fully deleted — no orphan refs
`git show 445ceab94:crates/pi-code-graph/src/search.rs` → file does not exist. Grep for `crate::search` and `use pi_code_graph::search` across the workspace — zero hits. The only textual reference to the old module is the doc comment in `bm25_adapter.rs:131` documenting the port provenance. ✓

### Tokenizer migration — no ASCII regression
Old: `is_ascii_alphanumeric` + `to_ascii_lowercase`. New: `is_alphanumeric` + `to_lowercase`. For ASCII-only input (all code in the workspace is ASCII), the predicates are identical: every ASCII alphanumeric is also Unicode alphanumeric, and `to_ascii_lowercase` produces the same result as `to_lowercase` for ASCII. Non-ASCII tokens (e.g., French identifiers like `élément`, CJK characters like `記憶`) are now correctly indexed where they were previously silently dropped. Strict improvement, zero ASCII regression. ✓

### Test coverage — old behaviors all ported
Old `search.rs` tests: `test_tokenize_camel_case`, `test_tokenize_snake_case`, `test_tokenize_mixed` → ported to `pi_knowledge_core::bm25` (identical assertions). `bm25_prefers_exact_symbol_match` → ported to `bm25_adapter` with added assertions on `path` and `node_index`. New test `unresolvable_hits_filtered` validates defense-in-depth path. Coverage is adequate for existing behaviors; the round-trip gap is noted in the P3 finding above. ✓

### Downstream consumer impact
`pi-natives/src/recall_engine.rs` and `pi-knowledge-worker/src/lane_org.rs` import `pi_knowledge_core::bm25::SearchIndex` directly — unaffected by the re-export change. `crates/pi-code-graph/src/hybrid.rs` imports `bm25_adapter::SearchHit` — structurally identical to old `search::SearchHit`. No internal breakage. ✓

# W0R-3: SemanticBackend Foundation

## [P1] `symbol_at` ignores `col` parameter — multi-symbol-per-line queries resolve to wrong symbol

**File:** `crates/pi-code-graph/src/semantic/annotation.rs:61-82`
**Why it's wrong:**
`symbol_at(&self, file, line)` takes `line: u32` but `type_at` receives `col: u32` and discards it via `_col`. When two symbols share a line (e.g., `let (a: i32, b: &str) = ...` — two `SymbolNode`s at line 5 cols 4 and 7), `symbol_at` hits the `sym.line == line` early-return with whichever symbol iteration encounters first. The caller querying col 7 gets `a`'s type. The `SymbolNode.column` field IS populated by tree-sitter extractors (1-indexed byte column), so column-aware resolution is available — it's just not wired.

**Impact:** Every `type_at` call at a multi-symbol line can return the wrong annotation. Affects TypeScript `const [a, b] = ...`, Rust `let (a, b) = ...`, Python `a, b = ...`, Elixir `{a, b} = ...` — any language where destructuring puts multiple symbols on one line.

**Suggested fix:**
Extend `symbol_at` to use `col` for tie-breaking when multiple symbols share the same line:

```rust
fn symbol_at(&self, file: &Path, line: u32, col: u32) -> Option<&SymbolNode> {
    let mut best: Option<&SymbolNode> = None;
    let mut best_line_distance: u32 = u32::MAX;
    let mut best_col_distance: u32 = u32::MAX;
    for node in self.graph.graph().node_weights() {
        let GraphNode::Symbol(sym) = node else { continue };
        if sym.file != file { continue; }
        if sym.line == line {
            // Same line: pick closest preceding column (or exact match)
            if sym.column <= col {
                let col_dist = col - sym.column;
                if col_dist < best_col_distance {
                    best_col_distance = col_dist;
                    best = Some(sym);
                }
            }
            // Don't early-return; there may be a closer match ahead
            continue;
        }
        if sym.line <= line {
            let distance = line - sym.line;
            if distance < best_line_distance {
                best_line_distance = distance;
                best_col_distance = u32::MAX; // reset col tiebreaker
                best = Some(sym);
            }
        }
    }
    best
}
```

Add a test with two symbols on the same line:

```rust
#[test]
fn type_at_picks_correct_symbol_on_multi_symbol_line() {
    // Build graph with two symbols at line 5: sym_a@col 4, sym_b@col 7
    let backend = AnnotationSemanticBackend::new(graph_with(
        sym("a", "src/foo.rs", 5, 4, Some("i32")),
        sym("b", "src/foo.rs", 5, 7, Some("&str")),
    ));
    assert_eq!(backend.type_at(&PathBuf::from("src/foo.rs"), 5, 4).repr.as_str(), "i32");
    assert_eq!(backend.type_at(&PathBuf::from("src/foo.rs"), 5, 7).repr.as_str(), "&str");
    // Query col 3 (before any symbol): nearest preceding at col 0 is...
    // Would fall through to closest-above (line < 5) if exists
}
```

---

## [P1] `rename_preview` and `references_narrowed` listed in PLAN but absent from trait — W1/W3 consumers blocked

**File:** `crates/pi-code-graph/src/semantic/mod.rs:65-102`
**Why it's wrong:**
The W0 task specification (from `.spell/agent/sessions/.../context.md`) defines the trait surface as: `type_at/type_definition_of/signature_at/inlay_hints/narrow_dispatch/references_narrowed/diagnostics/rename_preview/capabilities` plus data shapes `RenameError`, `WorkspaceEdit`. The shipped trait omits `references_narrowed` and `rename_preview` entirely, and `WorkspaceEdit`/`RenameError` data shapes are absent. If W1 (`LspSemanticBackend`) or W3 (`type_resolver`) needs these methods, adding them later with non-default signatures is a breaking change. Adding default-impl methods post-hoc would be non-breaking but may surprise W1 consumers expecting real implementations.

The doc comment on `mod.rs` claims "no new trait impls needed" for PLAN-320, but if `rename_preview` is needed before then, a trait break is inevitable.

**Suggested fix:**
Clarify with PLAN author whether `rename_preview`/`references_narrowed` were intentionally deferred. Options:
- If deferred: add a `// PLAN-319 W2+: rename_preview, references_narrowed` TODO comment on the trait + open a FUP.
- If needed now: add default impls:

```rust
/// Preview the effect of renaming a symbol. Returns the set of locations
/// that would be updated, or a `RenameError` if the rename is invalid.
fn rename_preview(&self, _file: &Path, _line: u32, _col: u32, _new_name: &str) -> Result<Vec<Location>, RenameError> {
    Err(RenameError::Unsupported)
}
```

---

## [P2] SymbolNode.column is 1-indexed but SemanticBackend col parameter is documented as 0-indexed

**File:** `crates/pi-code-graph/src/semantic/mod.rs:71` (trait doc), `crates/pi-code-graph/src/language/generic.rs:593-594` (extractor)
**Why it's wrong:**
The `SemanticBackend` trait doc says `col` is "0-indexed UTF-16 col per LSP convention." But tree-sitter extractors populate `SymbolNode::column` as `node.start_position().column as u32 + 1` — 1-indexed. When W1's `LspSemanticBackend` bridges tree-sitter positions (1-indexed `SymbolNode.column`) with LSP positions (0-indexed), off-by-one errors will occur. The `AnnotationSemanticBackend` currently ignores `col` entirely (see P1 above), masking the mismatch. Once `col` is actually used for resolution, the 1-indexed `SymbolNode.column` will disagree with the 0-indexed query `col` by 1.

**Suggested fix:**
Either (a) normalise `SymbolNode.column` to 0-indexed in tree-sitter extractors (replace `+ 1` with `+ 0` at 4 call sites in `generic.rs:593,728,837` + `typescript.rs` + `elixir.rs` + `clojure.rs`), or (b) document the discrepancy and add `+ 1` at the LSP bridge boundary in W1. Option (a) is cleaner — a single indexing convention across the stack — but requires updating all existing consumers of `SymbolNode.column` (check `query.rs` and `walker.rs` for column usage).

---

## [P2] PathBuf exact-equality for cross-file symbol lookup fails on non-canonical paths

**File:** `crates/pi-code-graph/src/semantic/annotation.rs:73`
**Why it's wrong:**
`sym.file != file` uses `PathBuf::eq()` — component-wise comparison. If the code graph is built with absolute paths (`/home/user/project/src/foo.rs`) and a query arrives with a relative path (`src/foo.rs`), or if one path has symlink components and the other is canonical, the comparison fails silently. `symbol_at` returns `None`, and `type_at` returns `InferResult::unknown()` — indistinguishable from "no symbol found" (no error surfaced).

**Real scenario:** The code graph is built by the indexer which receives paths from CLI args (often relative) or file-system walks (which may canonicalize). The semantic query layer in W3 (`type_resolver`) may receive paths from `CodePath` qualifiers, which could be absolute (from pi's workspace root resolution) or relative (from user input). Mismatch → silent no-result.

**Suggested fix:**
Either (a) canonicalize both sides before comparison (expensive per-query), (b) normalise paths at graph ingestion (store all `SymbolNode.file` as canonical), or (c) add a `try_canonicalize` fallback:

```rust
if sym.file != file {
    // Try canonicalized comparison as fallback for symlink/relative-path mismatch
    let sym_canon = std::fs::canonicalize(&sym.file);
    let file_canon = std::fs::canonicalize(file);
    if sym_canon.as_ref().ok() != file_canon.as_ref().ok() {
        continue;
    }
}
```

Option (b) is the right long-term fix: canonicalize paths once at indexer ingestion and store absolute canonical paths in `SymbolNode.file`.

---

## [P2] Location partial-range semantics undefined — `(end_line=Some(5), end_col=None)` has no meaning

**File:** `crates/pi-code-graph/src/semantic/mod.rs:189-200`
**Why it's wrong:**
`Location` has `end_line: Option<u32>` and `end_col: Option<u32>` as independent options. The constructor `Location::point()` sets both to `None`. The doc says "When `end_line` is `None`, the location is a single point" — implying both end fields are either `Some` or `None` together. But the type system doesn't enforce this: a consumer could construct `Location { end_line: Some(10), end_col: None, ... }` — a range with no end column — and downstream code has no contract for what that means. LSP uses `Position { line, character }` pairs for both start and end, never partial ranges.

**Suggested fix:**
Replace with a proper range type:

```rust
pub struct Location {
    pub file: PathBuf,
    pub line: u32,
    pub col:  u32,
    pub end:  Option<Position>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Position {
    pub line: u32,
    pub col:  u32,
}
```

Or at minimum, add a `/// Both end fields must be Some or None together` doc contract and a `debug_assert!` in `Location::point()`.

---

## [P2] `InferResult::is_unknown()` invariant is unenforced — `repr` can be non-empty when `confidence` is `Unknown`

**File:** `crates/pi-code-graph/src/semantic/mod.rs:136-148`
**Why it's wrong:**
The struct doc says `repr` is "Empty when `confidence = Unknown`", but `is_unknown()` only checks `confidence`:

```rust
pub fn is_unknown(&self) -> bool {
    matches!(self.confidence, Confidence::Unknown)
}
```

If a future backend constructs `InferResult { repr: TypeRepr::Text("useful"), confidence: Confidence::Unknown, source: TypeSource::Default }`, `is_unknown()` returns `true` but `repr.as_str()` returns `"useful"`. The `CompositeBackend::type_at` fallback logic uses `primary.is_unknown()` to decide whether to fall back — a backend that returns a meaningful type representation with `Confidence::Unknown` would be silently discarded.

**Current code is safe** because `AnnotationSemanticBackend::type_at` only returns either `InferResult::unknown()` (all-empty) or `InferResult { repr: Text(...), confidence: Annotated, ... }` — never Unknown with non-empty repr. But the invariant is documentation-only.

**Suggested fix:**
Either (a) strengthen `is_unknown()` to also check `repr`:
```rust
pub fn is_unknown(&self) -> bool {
    self.confidence == Confidence::Unknown || self.repr == TypeRepr::Empty
}
```
Or (b) add a constructor that enforces the invariant:
```rust
pub fn with_confidence(repr: TypeRepr, confidence: Confidence, source: TypeSource) -> Self {
    debug_assert!(confidence != Confidence::Unknown || repr == TypeRepr::Empty,
        "repr must be Empty when confidence is Unknown");
    Self { repr, confidence, source }
}
```

---

## [P3] `CompositeSemanticBackend::register_lsp` silently overwrites extension collisions

**File:** `crates/pi-code-graph/src/semantic/composite.rs:59-65`
**Why it's wrong:**
`register_lsp` uses `self.by_ext.insert(key, backend.clone())` — HashMap insert semantics, last writer wins. If a config bug registers two LSP backends for the same extension (e.g., `typescript-language-server` AND `vtsls` both registered for `"ts"`), the first registration is silently discarded. No warning, no error. The user gets only the second backend's capabilities and may wonder why the first backend isn't answering queries.

**Suggested fix:**
Add a `tracing::warn!` or log when overwriting:

```rust
if self.by_ext.contains_key(&key) {
    tracing::warn!(
        "CompositeSemanticBackend: extension {ext:?} already registered; replacing"
    );
}
self.by_ext.insert(key, backend.clone());
```

---

## [P3] `addr_eq` fat-pointer cast chain is non-obvious and fragile

**File:** `crates/pi-code-graph/src/semantic/composite.rs:110-113`
**Why it's wrong:**
The fallback guard uses:

```rust
!std::ptr::addr_eq(
    Arc::as_ptr(&backend) as *const (),
    Arc::as_ptr(&self.default) as *const (),
)
```

This works: `Arc::as_ptr(&backend)` returns `*const dyn SemanticBackend` (fat pointer), casting to `*const ()` discards the vtable metadata and compares only data pointers. Since `Arc::clone()` produces a new handle to the same allocation, the data pointers match. The approach is sound but assumes: (1) `Arc::as_ptr` for trait objects returns the data-pointer component of the fat pointer (true per std docs, but not obvious), (2) the cast to `*const ()` is a valid pointer-to-pointer cast that preserves address (true for thin pointers, true here because the fat→thin cast extracts the data address).

A refactor that wraps `self.default` in another `Arc` layer or introduces `Arc<dyn SemanticBackend>` for the default could break this without compiler error.

**Suggested fix:**
Add a small helper and comment:

```rust
/// Returns true when two Arcs point to the same allocation, even when
/// their type parameters differ (e.g. `Arc<dyn Trait>` vs `Arc<Concrete>`).
fn arc_ptr_eq<A, B>(a: &Arc<A>, b: &Arc<B>) -> bool {
    std::ptr::addr_eq(
        Arc::as_ptr(a) as *const (),
        Arc::as_ptr(b) as *const (),
    )
}
```

Then use `arc_ptr_eq(&backend, &self.default)`.

---

## Confirmed-correct items (no finding needed)

### Trait method defaults match Capabilities::default()
`Capabilities::default()` → all false. Default trait impls: `type_definition_of→None`, `signature_at→None`, `inlay_hints→Vec::new()`, `narrow_dispatch→candidates.to_vec()`, `diagnostics→Vec::new()`. All return "no information" — consistent with no capabilities advertised. ✓

### No-extension files fall back to default correctly
`pick()`: `file.extension()` → `None` → `unwrap_or_default()` → `""` → `by_ext.get("")` → `None` → `self.default.clone()`. Files like `Makefile`, `Dockerfile`, `README` route to `AnnotationSemanticBackend`. ✓

### extension normalisation handles all cases
`normalise_ext`: strips leading `.`, lowercases. Inputs `"RS"`, `".Ex"`, `"heex"` all normalise to `"rs"`, `"ex"`, `"heex"`. Test `extension_normalisation_handles_dot_prefix_and_case` covers mixed inputs with `.rs`, `.ex`, `.heex`, `WIDE.RS`, `case.EX` file paths. ✓

### signature_at ↔ LSP SignatureHelp field mapping
`SignatureInfo { signature, parameters, active_param, documentation }` maps 1:1 to LSP's `SignatureInformation { label, parameters, activeParameter, documentation }`. No information loss — the LSP backend can populate all fields. ✓

### Narrow dispatch signature is LSP-compatible
`narrow_dispatch(&Location, &[Location]) → Vec<Location>` — the LSP backend can implement this by querying `textDocument/typeDefinition` for the call site receiver and filtering candidates by declaring type. No conversion overhead from the signature shape. ✓

### Blank detail → Unknown is safe
All tree-sitter extractor paths that set `detail: Some(...)` produce non-whitespace output: `signature_snippet` in `generic.rs` filters empty lines and joins with `" "`, taking first 200 chars; TypeScript takes first line and trims; Clojure uses `format!("ns {}", name)` or `format!("{head} {name}")` or literal `"keyword reference"`. No path produces an all-whitespace detail that would be incorrectly surfaced. ✓

### O(N) symbol_at acceptable at current scale
Doc comment in `annotation.rs` notes "O(N) over the graph node set; fine for the current scale, can be indexed later." Typical code graphs have 10³–10⁴ nodes; O(N) per query is acceptable until query volume grows. ✓

### Confidence variants are discriminant
Test `confidence_distinguishes_annotated_from_inferred` verifies `Annotated` ≠ `Inferred` ≠ `Heuristic` ≠ `Unknown`. Callers can safely match on these to filter by certainty. ✓

### CompositeBackend capabilities union
`capabilities()` returns bitwise-OR across all registered backends. Comment notes per-file precision requires `pick(file).capabilities()`. Consumers that check top-level capabilities before dispatching get a conservative yes (false positive allowed, false negative impossible). ✓

### CompositeBackend narrow_dispatch routes by call site file
`narrow_dispatch` calls `self.pick(&call_site.file)` — correct, since candidates are tied to the call site's file context. ✓

### LineRange inclusive semantics documented
Doc: "Inclusive [start, end] line range. 1-indexed." Matches LSP convention (LSP uses 0-indexed but the trait uses 1-indexed line throughout — consistent). ✓

### Arc<CodeGraph> cloning pattern
`AnnotationSemanticBackend` holds `Arc<CodeGraph>`, `CompositeSemanticBackend` holds `Arc<AnnotationSemanticBackend>`. Multiple consumers share one graph snapshot — no stale-data issues within a query lifetime. The `SemanticBackend: Send + Sync` bound ensures thread-safe sharing. ✓

### Trait stability for W1 LSP impl
All trait methods take `&self` (shared reference) — LSP backends with internal state (process handle, channel) can share via `Arc<Mutex<...>>` inside their struct. The `Send + Sync` bound is satisfied. No lifetime parameters on methods — backend references are valid for the duration of the call. ✓
