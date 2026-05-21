# PLAN-310 W1.5 — Review of `pi-knowledge-core`

> Reviewer: forward-looking surface audit (read-only). The crate compiles,
> 39 tests green, clippy clean. Question on the table: will this surface hold
> when W2 (usearch), W4 (org-engine), W5 (tantivy delete + ingest), W6
> (memory tool) wire into it?

Findings ranked HIGH → MEDIUM → LOW. Severity is impact-on-consumers, not
"is this code wrong today".

---

### F1 — `EdgeKind` enum is missing 11 of code-graph's 16 variants
**File:** `crates/pi-knowledge-core/src/graph.rs:27-46`
**Confidence:** HIGH
**Severity:** BLOCKER
**Class:** API / CROSS-WAVE

The crate doc claims "Unified edge kind across code-graph + org-graph. New
variants land here; no other crate defines its own edge kind enum." But
`crates/pi-code-graph/src/model.rs:69-87` ships 16 variants
(`Defines, Imports, Calls, References, Inherits, Renders, Styles, Requires,
Refers, Aliases, Implements, Dispatches, Tests, UsesKeyword, TypeImports,
TypeParameterOf`); the new enum has only 5 in the code-graph lane
(`Imports, References, Definition, Calls, Contains`). When W2 absorbs
`pi-code-vectors` and W5 deletes `pi-org-recall`, code-graph migration
either has to (a) wholesale rename its semantics (`Defines` →
`Definition`, `Refers` collapses into `References`, losing Clojure-vs-Rust
distinction), or (b) extend this enum, which then defeats the "domain
agnostic" framing. Plus `EdgeKind::Action` is *reserved* in
`specs/org-graph-memory.md` ("`ACTION` edge kind is reserved for the next
iteration") but already public here — locks the layout before the spec
calls for it. A consumer adding a code edge between two existing
variants will rotate every enum discriminant index and corrupt
already-written caches (bincode 1 encodes enum variant as positional
u32). Either ship the full union now or make `TypedGraph` generic over
`E: Eq + Hash + Copy + Serialize + DeserializeOwned` so each consumer
defines their own — petgraph itself takes the generic route.

**Suggested fix:** Either land the missing variants now (`Defines,
Inherits, Renders, Styles, Requires, Refers, Aliases, Implements,
Dispatches, Tests, UsesKeyword, TypeImports, TypeParameterOf` — see
`crates/pi-code-graph/src/model.rs:70`), or switch the graph to
`StableGraph<Node, E>` parameterised on the kind. If keeping the closed
enum, add an `Other(String)` variant (org-engine already has one, see
`crates/pi-org-engine/src/edge.rs:27`) for forward-compat and lock the
variant order with an explicit `#[repr(u32)]` + a `serialize_stable`
test that asserts the discriminant integers.

```rust
// crates/pi-knowledge-core/src/graph.rs, replace the enum:
pub enum EdgeKind {
    // Code lane (matches pi-code-graph EdgeKind ordinally)
    Defines, Imports, Calls, References, Inherits,
    Renders, Styles, Requires, Refers, Aliases,
    Implements, Dispatches, Tests, UsesKeyword,
    TypeImports, TypeParameterOf,
    // Org lane (FEAT-631)
    Involved, About, Produced, DistilledFrom, Mentions,
    Supersedes, DerivedFrom, Blocks, Action,
    Contains,
    // Forward-compat for foreign drawer tokens
    Other(String),
}
```

---

### F2 — `Node::payload: serde_json::Value` regresses org-engine type-safety
**File:** `crates/pi-knowledge-core/src/graph.rs:88-100`, `crates/pi-knowledge-core/src/graph.rs:303-373` (custom serde)
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** API / PERF / PERSIST

Today's `pi-org-engine::graph::TypedGraphNode` is a typed struct (`id,
kind, title, file, dangling` — see `crates/pi-org-engine/src/graph.rs:570-577`),
and `pi-code-graph::model::GraphNode` is a `File | Symbol` enum carrying
`PathBuf`, `SymbolKind`, line/column. Collapsing into
`payload: serde_json::Value` means every consumer round-trips through
`serde_json::to_value` on insert and `serde_json::from_value::<T>(node.
payload.clone())` on read — the clone is forced because `Value` isn't
`Copy` and `from_value` takes ownership. Worse, the custom `Serialize`
impl re-encodes payload as a JSON *string* before bincode (line 327,
`payload: serde_json::to_string(&n.payload).unwrap_or_default()`) and
silently drops the value on encoder failure (`unwrap_or_default()` →
`""`), then re-parses on deserialize — that's two JSON walks per node
per cache load. At 10k nodes this is wasted CPU and quietly corrupts a
node whose payload happens to fail to serialise (returns empty string,
then `from_str("")` on load errors — see line 360). A generic
`TypedGraph<P>` where `P: Serialize + DeserializeOwned + Clone` is the
textbook fix; petgraph already requires this on the node weight.

**Suggested fix:**

```rust
// crates/pi-knowledge-core/src/graph.rs:88
pub struct Node<P = serde_json::Value> {
    pub key: NodeKey,
    pub kind: String,
    pub payload: P,
}

pub struct TypedGraph<P = serde_json::Value, E = EdgeKind> {
    graph: StableGraph<Node<P>, E>,
    index: BTreeMap<NodeKey, NodeIndex>,
}
```

…and drop the JSON-string-round-trip custom serde — derive `Serialize` /
`Deserialize` on `TypedGraph<P, E>` directly once payload is generic.
Replace the silent `unwrap_or_default()` with a proper error path.

---

### F3 — `add_edge` is not idempotent; W5 re-ingest will accumulate parallel edges
**File:** `crates/pi-knowledge-core/src/graph.rs:128-133`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** API / CROSS-WAVE

`upsert_node` is documented as idempotent ("If the key already exists
the payload is replaced in-place"), but `add_edge` calls
`StableGraph::add_edge` which appends — calling
`g.add_edge(&a, &b, Imports)` twice gives two parallel `Imports` edges
between `a` and `b`. W5's notify-driven incremental ingest is the
obvious caller: when a file changes, it'll re-run `upsert_node` for
every symbol then re-add edges; without an `upsert_edge` (or a
"clear-edges-from-this-node" helper), every save doubles the edge
count. `neighborhood()` deduplicates by node but every parallel edge
re-runs the kind filter — bounded but wasteful — and
`{in,out}_edges()` returns the duplicates verbatim, which the W6
memory tool will then show twice to the agent. Worse: there's no test
that pins idempotence either way, so the bug is silent.

**Suggested fix:** Add an `upsert_edge` that no-ops on existing
`(from, to, kind)` triple, plus a `clear_outgoing(&NodeKey)` for
re-ingest. Pin both with a test.

```rust
// crates/pi-knowledge-core/src/graph.rs:128
pub fn upsert_edge(&mut self, from: &NodeKey, to: &NodeKey, kind: EdgeKind) -> Option<()> {
    let from_idx = *self.index.get(from)?;
    let to_idx   = *self.index.get(to)?;
    if self.graph.edges_connecting(from_idx, to_idx).any(|e| *e.weight() == kind) {
        return Some(());
    }
    self.graph.add_edge(from_idx, to_idx, kind);
    Some(())
}

pub fn clear_outgoing(&mut self, key: &NodeKey) {
    let Some(&idx) = self.index.get(key) else { return };
    let to_remove: Vec<_> = self.graph.edges(idx).map(|e| e.id()).collect();
    for eid in to_remove { self.graph.remove_edge(eid); }
}
```

---

### F4 — Tokenizer drops every non-ASCII character; org/memory titles will lose tokens
**File:** `crates/pi-knowledge-core/src/bm25.rs:161-188`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** API / CROSS-WAVE

`tokenize` splits on `!c.is_ascii_alphanumeric() && c != '_' && c != '-'`.
Any code point ≥ U+0080 is treated as a separator and discarded. For
the code-graph migration this is acceptable (symbols are mostly ASCII);
for W4 org-engine and W6 memory it's not — concept titles and episode
bodies are user-language content (the prior `pi-org-recall::fts` used
Tantivy's tokenizer over the full Unicode range). A French concept
titled "Cadrage de l'épisode" tokenises to
`["cadrage", "de", "l", "pisode"]` (loses the `é`), CJK strings
tokenise to the empty vector and the document is silently dropped at
`from_docs` (line 56-57: `if tokens.is_empty() { return None; }`). The
loss is invisible — the doc just never matches anything BM25.
Tests cover only ASCII (`FluidOrchestrator`, `build_system_prompt`,
`getHTTPResponse`).

**Suggested fix:** Switch the splitter to Unicode-aware character
classification, and add a test for at least one non-ASCII corpus. The
keep-set should be `alphanumeric` (any script) plus `_` / `-`.

```rust
// crates/pi-knowledge-core/src/bm25.rs:163
for part in text.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-') {
```

(plus the symmetric change in the corresponding line of `split_camel_case`
if W2/W4 want CJK/diacritic-aware splitting; the simpler fix unblocks
W4 by itself.)

---

### F5 — `KnowledgeMeta::status_against` ignores `embedder_model` and `embedder_dim`
**File:** `crates/pi-knowledge-core/src/cache.rs:54-69`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** PERSIST / CROSS-WAVE

`KnowledgeMeta` carries `embedder_model: String` and `embedder_dim:
usize` for W3 onwards, but `status_against` only compares
`schema_version`, `fingerprint.git_head`, and `fingerprint.files`.
When W3 wires in the bge-m3 embedder (1024-dim), then later swaps for
a smaller model, `status_against` returns `Fresh` and the loader
will deserialise a vectors.uidx full of 1024-dim points into a
768-dim index — usearch will either refuse or, worse, accept garbage.
Embedder mismatch is the single most common cause of "recall returns
weird hits" once vectors land, and the dead fields here suggest the
author *intended* to wire it but didn't. Better to catch at W1.5 than
at W3 cutover.

**Suggested fix:** Add embedder comparison to `status_against`, taking
the expected `(model, dim)` from the caller (so W2 callers can pass
their own; W5 can pass the active embedder). Existing tests don't need
to break because the legacy two-arg form can default both to "" / 0.

```rust
// crates/pi-knowledge-core/src/cache.rs:55
pub fn status_against(
    &self,
    current: &WorkspaceFingerprint,
    expected_model: &str,
    expected_dim: usize,
) -> CacheStatus {
    if self.schema_version != KNOWLEDGE_SCHEMA_VERSION { /* … */ }
    if !expected_model.is_empty()
        && (self.embedder_model != expected_model || self.embedder_dim != expected_dim)
    {
        return CacheStatus::Stale {
            reason: format!(
                "embedder {}/{} != current {}/{}",
                self.embedder_model, self.embedder_dim, expected_model, expected_dim,
            ),
        };
    }
    // … existing git_head / files checks
}
```

---

### F6 — `repo_hash` uses `DefaultHasher`; cache dirs orphan on every Rust toolchain bump
**File:** `crates/pi-knowledge-core/src/cache.rs:103-114`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** PERSIST

The author already flagged this in a comment ("sha2 is not present in
the workspace … pre-existing on-disk caches from `pi-org-recall`
simply become unreferenced") and rationalised it as a one-shot
migration. The structural problem is bigger: `std::hash::DefaultHasher`
is documented as "may change in future releases of Rust". So every
toolchain bump silently orphans every user's cache dir, forcing a
full BM25/vector/graph rebuild — for a 10k-concept index that's the
~2 second ingest the spec calls expensive. `sha2` is two transitive
deps away (it's already pulled in by `git2` / `rustls`; check
`cargo tree -i sha2` in the workspace) — a brief proxy_bash run
would confirm before declining it. If sha2 truly isn't free, a
hand-rolled FNV-1a constant across Rust versions costs ~10 lines and
is stable forever.

**Suggested fix:** Add `sha2 = "0.10"` to `pi-knowledge-core`'s
dependencies (it's already in the workspace lockfile via `git2`
transitively) and switch:

```rust
// crates/pi-knowledge-core/src/cache.rs:108
fn repo_hash(repo_root: &std::path::Path) -> crate::Result<String> {
    use sha2::{Digest, Sha256};
    let canon = std::fs::canonicalize(repo_root)?;
    let mut hasher = Sha256::new();
    hasher.update(canon.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    Ok(hex::encode(&digest[..6]))   // 12 hex chars, same as pi-org-recall
}
```

If `sha2` really can't be added, pin a hand-rolled FNV-1a in this
file with a doc-test that asserts a known input → known hex output;
that makes the hash-stability contract explicit.

---

### F7 — `neighborhood` / `path` lose edge data that `pi-org-engine` callers depend on
**File:** `crates/pi-knowledge-core/src/graph.rs:159-204` (neighborhood), `crates/pi-knowledge-core/src/graph.rs:212-265` (path)
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** API / CROSS-WAVE

`pi-org-engine::graph::neighborhood` returns `Subgraph { nodes, edges
}` (with full `TypedEdge { from, to, kind }`) and `path` returns
`GraphPath { edges }` — see `crates/pi-org-engine/src/graph.rs:586-597`.
The new crate returns `Vec<(NodeKey, usize)>` (just keys + hop count)
and `Option<Vec<NodeKey>>` (just keys) — edges are stripped. W4
migration of org-engine consumers (and the `executeOrg::subgraph`
TS dispatch in `packages/org/src/tool.ts:1190`) will either lose
the edge-kind data agents need ("WHY is this node in the
neighborhood?") or have to re-derive edges by post-filtering
`in_edges` / `out_edges` per node — quadratic in the neighborhood
size. The W6 memory tool's `FusedHit::why` story breaks similarly:
the agent prompt's "why this was returned" loses the typed edge that
brought it into the neighborhood seed.

**Suggested fix:** Return richer types and keep the BFS internal.

```rust
// crates/pi-knowledge-core/src/graph.rs
pub struct Neighbor { pub key: NodeKey, pub depth: usize, pub via: Option<EdgeKind> }
pub fn neighborhood(...) -> Vec<Neighbor>;

pub struct PathStep { pub from: NodeKey, pub to: NodeKey, pub kind: EdgeKind }
pub fn path(...) -> Option<Vec<PathStep>>;
```

The depth bookkeeping is already in the BFS; recording the parent
edge alongside the parent index is a one-field addition to the
queue/parent map.

---

### F8 — `cache.rs` has no multi-file atomic save; W5 will race partial caches
**File:** `crates/pi-knowledge-core/src/cache.rs:1-12` (no helper exported)
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** API / PERSIST

`pi_workspace_cache::CacheStore::save<T>(name, &T)` saves one entry at
a time with internal atomic rename. W5 ingest writes at least four
artefacts together: `meta.bin`, `bm25.bin`, `graph.bin`,
`vectors.uidx` (per the doc on `KnowledgeMeta`). If the process dies
between `save("meta", …)` and `save("bm25", …)`, the next session
opens `meta.bin` (now newest), validates `status_against` Fresh,
then tries to read `bm25.bin` from the previous schema — silent
mis-deserialisation if the BM25 layout changed across the bump.
The plan brief explicitly called this out: "atomic save helper that
takes a list of `(name, &T)` to write transactionally". This is
missing.

**Suggested fix:** Add a `save_all` helper that stages every entry
to a `.tmp` sibling first and renames in one pass after every write
succeeds. Order matters: write `meta.bin` *last* so a stale `meta`
plus fresh-blobs is impossible.

```rust
// crates/pi-knowledge-core/src/cache.rs
pub fn save_all<I, T>(store: &CacheStore, entries: I) -> crate::Result<()>
where
    I: IntoIterator<Item = (&'static str, T)>,
    T: serde::Serialize,
{
    let entries: Vec<_> = entries.into_iter().collect();
    // Stage every blob to <name>.tmp, then rename in dependency order,
    // with meta last so a partial state never looks Fresh.
    todo!("see W1.5-gaps for the implementation skeleton")
}
```

---

## Summary — to fix in W1.5-gaps wave

HIGH-confidence BLOCKER / MAJOR (8 findings):

| # | Title | Severity |
|---|---|---|
| F1 | `EdgeKind` enum missing code-graph variants + reserved Action + closed-enum bincode trap | BLOCKER |
| F2 | `Node::payload: serde_json::Value` should be generic | MAJOR |
| F3 | `add_edge` not idempotent → W5 ingest dupes | MAJOR |
| F4 | Tokenizer drops non-ASCII; org/memory titles silently lost | MAJOR |
| F5 | `KnowledgeMeta::status_against` ignores embedder model/dim | MAJOR |
| F6 | `repo_hash` via `DefaultHasher` → orphans on toolchain bump | MAJOR |
| F7 | `neighborhood`/`path` lose edge data org-engine needs | MAJOR |
| F8 | No multi-blob atomic save helper for W5 ingest | MAJOR |

## Deferred to FUP

- **bincode 1.3 pin** — v1 in maintenance, v2 has breaking format changes.
  Re-evaluate when other workspace deps migrate. Not blocking.
- **`FusionWeights::default()` hardcodes lane names** `"bm25" / "vector" /
  "graph"` — leaks per-domain assumption. Consumer overrides work, but a
  domain-neutral default (e.g. `BTreeMap::new()` → all lanes treated equal)
  would be cleaner. Class: API.
- **`Why::recency / backlinks / confidence`** semantic: multiplier `1.0`
  means *both* "feature disabled" and "no signal for this id" — agents
  reading the field can't distinguish. Add an `Option<f32>` or a separate
  `applied: bool` flag. Class: NAMING.
- **`Document::id(&self) -> String`** forces an allocation per doc per
  rebuild. Switch to `Cow<'_, str>` once a real perf measurement on a
  10k-doc corpus shows it matters. Class: PERF.
- **`SearchIndex` token storage** — every token is a separate `String` in
  `tokens: Vec<String>` + `frequencies: BTreeMap<String, usize>` per
  doc. Interning to `Arc<str>` shared across the corpus halves the
  allocation count; not urgent at 10k docs (~16 MB headers). Class: PERF.
- **BM25 score is never propagated to fusion** — fusion takes
  `&[String]` (rank-only); the raw BM25 score in `SearchHit::score` is
  dropped at the lane boundary. RRF is rank-based by design so this is
  textbook-correct, but worth a comment in `fusion::RankedList` noting
  callers shouldn't try to feed score-weighted scaling here. Class: API.
- **Missing tests**:
  - graph cycle (a→b→c→a) BFS termination invariant
  - fusion recency monotonic decay across multiple `elapsed` values
  - cache `dirs_cache_base()` returns `Error` when *both* `XDG_CACHE_HOME`
    and `HOME` are unset
  - tokenizer pin-test for non-ASCII corpus (will fail until F4 lands;
    can be added as `#[ignore]` first)
  - bincode round-trip with a `Node` whose payload `serde_json::Value`
    fails to serialise — currently silently becomes `""` (F2). Class: TEST.
- **`Document::body()` semantics** — implementations might return
  `Some("")` vs `None` inconsistently; both currently produce different
  index shapes. Add a doc note pinning the contract ("None ≡ Some(\"\")
  ≡ no body indexing"). Class: NAMING.

