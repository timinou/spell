# PLAN-310 W5.5 — Review of the convergence wave

> Reviewer: forward-looking surface audit (read-only). W5 deleted
> `pi-org-recall` + `pi-code-vectors`, dropped tantivy + hnsw_rs, and folded
> recall onto `pi_knowledge_core::recall` (new), `::ingest` (new), and
> `pi_natives::recall_engine` (rewritten, 622 non-test LOC + 12 tests).
> `pi_org_engine::graph::TypedGraph` now `impl RecallGraph`. The crate compiles
> and the cargo tree is materially leaner. Question on the table: does this
> surface hold up for W6 (memory tool), W7 (producers), W9 (personal store),
> and W11 (public docs)?

Findings ranked by confidence × severity. The compaction is real and most
seams are clean — the issues below cluster around two themes: (a) errors are
silently absorbed in three places in the hot path, and (b) artifacts W1.5
shipped to fix exactly this class of problem (`KnowledgeMeta`,
`purge_if_stale`) are present but **not wired in**, so W7 producers will
have to either retrofit the wiring or fork the contract.

---

### F1 — Hot recall path swallows three classes of error → silent quality degradation
**File:** `crates/pi-knowledge-core/src/recall.rs:377-385`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** API / OPERATIONAL

Two adjacent unwraps drop information that the agent prompt needs:

```rust
// recall.rs:377-385
let query_vec = ctx
    .embedder
    .embed_query(text)
    .unwrap_or_else(|_| vec![0.0; ctx.embedder.dim()]);   // ← (1)
ctx.vec
    .search(&query_vec, over_fetch)
    .unwrap_or_default()                                  // ← (2)
    .into_iter()
    .filter_map(...)
```

(1) When the embedder fails (worker process down, socket timeout, JSON parse
error — all reachable via W3's socket layer at
`crates/pi-natives/src/embedding_worker.rs:175-238`), recall substitutes a
**zero vector** as the query. Against a cosine-normalised usearch index, a
zero vector has zero norm; usearch returns distance=1.0 for every doc,
producing a meaningless ranking that pollutes the RRF fusion. Worse, the
caller has no way to tell it happened: `RecallHit` has no `lane_status` and
`WhyHit::vector_rank` carries an `Option<usize>` indistinguishable from a
real low rank. Compare the safer path: return empty `vector_ranked`, which
RRF already handles (lane simply contributes 0).

(2) `vec.search()` errors — the most likely one is the
`"dim mismatch on query: expected 1024, got N"` raised by
`vec.rs:78-82` — silently collapse to empty hits. W2.25 F1 flagged the
same pattern at `crates/pi-code-graph/src/query.rs:162`; W5 re-imported it.
The bug surfaces operationally as "vector search just stopped working
yesterday" with no log line, no error code, no telemetry — the exact
symptom W7's producers are going to be debugging at 3am.

(2b) The embedder-failure path (1) also blocks the vector-lane self-healing
in W3's socket world: if the worker died and the supervisor has restarted
it, the *next* successful query would have re-embedded — but the zero-vec
path returns a result, the user sees an answer, and never re-tries.

**Suggested fix:** on `embed_query` error, return empty `vector_ranked`
(don't fabricate a zero vector); on `vec.search` error, log + return empty
+ set a per-hit `lane_status` flag the caller (and `WhyHit`) can surface:

```rust
// recall.rs:374
let vector_ranked: Vec<String> = if let Some(text) = query.text.as_deref()
    && weights.vector > 0.0
{
    match ctx.embedder.embed_query(text) {
        Ok(qv) => match ctx.vec.search(&qv, over_fetch) {
            Ok(hits) => hits.into_iter()
                .filter_map(|h| key_to_id.get(&h.node_id).copied().map(str::to_string))
                .filter(|id| kind_in_scope(id_to_kind.get(id.as_str()).copied().unwrap_or("")))
                .collect(),
            Err(e) => {
                tracing::warn!(error = %e, "vector lane search failed");
                Vec::new()
            }
        },
        Err(e) => {
            tracing::warn!(error = %e, "vector lane embedder failed");
            Vec::new()
        }
    }
} else { Vec::new() };
```

(pi-knowledge-core doesn't pull `tracing` today; either add it now — W6/W7
will want it anyway — or push the log through an error-callback hook on
`RecallContext`.)

---

### F2 — `recall_engine` cache bypasses `KnowledgeMeta` + `purge_if_stale`; embedder swap will silently serve stale 1024-dim vectors
**File:** `crates/pi-natives/src/recall_engine.rs:267-340, 56` (`const DIM: usize = 1024`)
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** CROSS-WAVE / PERSIST / CONVERGENCE

W1.5 shipped `KnowledgeMeta { schema_version, fingerprint, embedder_model,
embedder_dim, built_at }` and `cache::save_all` to atomically persist it.
W5 shipped `ingest::purge_if_stale(cache_dir, fp, expected_model,
expected_dim)` that consumes exactly this metadata. **Neither is referenced
by `recall_engine`.** Instead, `EngineCacheEntry` (line 232) persists
`{ fingerprint, items }` — no `embedder_model`, no `embedder_dim`, no
`schema_version`. The disk fast-path at `try_load_warm` (271) compares only
`entry.fingerprint != *current_fp` and then loads `vec.uidx` blindly.

Failure modes that pass the gate today:

1. **Embedder swap, same dim.** Operator points `PI_EMBEDDING_WORKER` at a
   different bge-variant or a future bge-m3-finetune — same 1024 dim, same
   file set, identical fingerprint. `try_load_warm` returns success; the
   cached vectors (built by the old model) are searched with new-model
   query embeddings. Cosine similarity between two models' embedding spaces
   is meaningless. Recall returns plausible-looking but semantically
   incoherent ranks. No log, no error.
2. **Embedder dim bump.** If a future worker advertises 768 or 1280 dim,
   `WorkerEmbedderAdapter::dim()` returns the hardcoded `DIM = 1024`
   (line 583) — divergence from reality. Even if the const were tracked
   dynamically, the cached `.uidx` was built at the old dim; `vec.search`
   would `Err` on dim mismatch and F1's `unwrap_or_default()` swallows it.
3. **Schema bump.** `EngineCacheEntry`'s bincode layout has no version
   prefix; adding a field is a silent break that turns into a deserialise
   error on every existing user's cache (best case) or wrong-field
   misinterpretation (worst).

The W2.25 review (F1, F2, F3) flagged this exact pattern in
`pi-natives::code_graph`'s `.fp` sidecar. W5 had the opportunity to
converge but instead minted a *third* cache shape — engine.bin (recall) vs
.fp (code-graph) vs meta.bin (the unused `KnowledgeMeta`/`purge_if_stale`
contract). Without convergence, W7 producers face three persistence shapes;
W11 docs will have three "how cache invalidation works" sections.

**Suggested fix:** make `recall_engine` the first real consumer of
`purge_if_stale` and store the meta alongside `vec.uidx`:

```rust
// crates/pi-natives/src/recall_engine.rs:267 (try_load_warm)
use pi_knowledge_core::ingest::purge_if_stale;

fn try_load_warm(&self, current_fp: &WorkspaceFingerprint) -> Option<WarmEngine> {
    let model = std::env::var("PI_EMBEDDING_MODEL").unwrap_or_else(|_| "bge-m3".into());
    match purge_if_stale(&self.cache_dir, current_fp, &model, DIM) {
        Ok(true) => { /* fresh */ }
        Ok(false) => return None,        // purge_if_stale already wiped
        Err(_) => return None,
    }
    // existing engine.bin / bm25.bin / vec.uidx loads...
}

fn save_warm(&self, warm: &WarmEngine) -> Result<(), String> {
    // write engine.bin / bm25.bin / vec.uidx as today, plus:
    let meta = KnowledgeMeta {
        embedder_model: model.clone(),
        embedder_dim: DIM,
        ..KnowledgeMeta::new(warm.fingerprint.clone())
    };
    let meta_path = self.cache_dir.join("meta.bin");
    fs::write(&meta_path, bincode::serialize(&meta)?)?;
    Ok(())
}
```

This collapses three cache contracts toward one and lets the next two waves
(W7 producers, W9 personal store) inherit invalidation behaviour for free.

---

### F3 — `RecallQuery::profile` + `RecallProfileRegistry` are wired through the NAPI surface but never consulted
**File:** `crates/pi-knowledge-core/src/recall.rs:104-105, 175-219, 332` (`recall()` reads only `query.weights`)
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** API / CONTRACT / W7-BLOCKER

`RecallQuery` has a `profile: Option<String>` field; `org_buffer.rs:824`
parses it from JSON. `RecallProfileRegistry::defaults()` registers
`"session-start"` and `"priors"`. **No production code path reads
`query.profile`, instantiates `RecallProfileRegistry`, or applies a profile
to a query.** `recall()` at line 332 only consults `query.weights`. A caller
passing `{ profile: "session-start" }` silently gets the default
FusionWeights (`0.3 / 0.5 / 0.2 / k=60`) — *not* the registered profile.

Two compounding problems:

1. **The contract is a lie for the agent.** Per PLAN-310 W7,
   session-start should issue `memory.search { profile: "session-start" }`
   and get a curated set of priors. Today that JSON parses, the field is
   stored, and the engine ignores it. The first time anyone notices is
   when W7 agent-prompt fixtures don't match expectations.
2. **The session-start profile is hollow even if it were honoured.**
   `RecallProfileRegistry::defaults()` at line 193:
   `FusionWeights { bm25: 0.0, vector: 0.0, graph: 0.0, k: 60.0 }`. Every
   lane gate in `recall()` (e.g., `if weights.bm25 > 0.0 { ... } else
   { Vec::new() }`) short-circuits to empty. The fused result is empty.
   `session-start` returns zero hits regardless of corpus content. Combined
   with (1), the bug is invisible.

`"priors"` has sane weights but no caller. The whole `RecallProfile*`
surface is currently dead code that exists to be linked, suggesting it was
intended as a W7 hand-off; the hand-off didn't happen.

**Suggested fix (minimal, lets W7 land cleanly):** thread the registry
through `RecallContext` (or take it by argument to `recall`), apply the
profile *before* the existing weight resolution, and define the session-
start profile in terms that actually returns hits:

```rust
// crates/pi-knowledge-core/src/recall.rs:332 (top of recall())
pub fn recall(
    query: RecallQuery,
    ctx: &RecallContext,
    profiles: &RecallProfileRegistry,
) -> Result<Vec<RecallHit>> {
    let query = if let Some(name) = query.profile.as_deref() {
        if let Some(p) = profiles.get(name) {
            RecallQuery {
                scope:       if query.scope.is_empty() { p.scope.clone() } else { query.scope },
                weights:     query.weights.or(Some(p.weights.clone())),
                graph_hops:  if query.graph_hops == 0 { p.graph_hops } else { query.graph_hops },
                graph_kinds: if query.graph_kinds.is_empty() { p.graph_kinds.clone() } else { query.graph_kinds },
                limit:       if query.limit == 0 { p.limit } else { query.limit },
                ..query
            }
        } else { query }
    } else { query };
    // ... existing body unchanged
}
```

And re-spec `"session-start"`: weights live (e.g. `0.4 / 0.5 / 0.1`), scope
narrowed to `["concept"]`, `graph_hops: 0`, `limit: 12` — the W7 plan body
already implies this shape.

---

### F4 — `recall_dual` fuses two independent RRF outputs by raw score; W9 cross-root ranking will be wrong
**File:** `crates/pi-knowledge-core/src/recall.rs:498-525`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** ALGORITHM / CROSS-WAVE (W9)

`recall_dual` runs `recall()` independently against `cwd` and `personal`,
deduplicates by id (cwd wins on collision), then sorts the *union* by the
per-context RRF score. RRF scores are not comparable across two separate
fusions: `sum(weight_l / (k + rank_l + 1))` depends on (a) which lanes
contributed in that context and (b) the lengths of those lanes (which
determine the rank-distribution of any given doc). A document ranked
#1 in personal (RRF score ~ 0.013) loses against a document ranked #15
in cwd (RRF score also ~ 0.013, but it lost to 14 better cwd docs). The
final ordering is statistically defensible but semantically arbitrary —
the user sees personal hits clustered at the bottom or top depending on
corpus size ratios, not on relevance.

The right shape: union both lanes' inputs *before* RRF, label by origin
(`source: cwd | personal`), let RRF score once across the unified ranking.
That's the only way scores stay commensurate.

Mitigating context: W9 isn't here yet and personal corpora will start
empty. But the surface is what W9 will pin against; landing it wrong now
means W9 has to either accept the bias or rewrite the fusion path.

**Suggested fix:** push the union into the lane lists, then call `rrf()`
once:

```rust
// crates/pi-knowledge-core/src/recall.rs:498
pub fn recall_dual(query: RecallQuery, ctx: &DualContext) -> Result<Vec<RecallHit>> {
    if !query.include_personal || ctx.personal.is_none() {
        return recall(query, &ctx.cwd);
    }
    // Build per-lane rankings unified across cwd + personal.
    let cwd_lanes = collect_lane_rankings(&query, &ctx.cwd)?;
    let personal_lanes = collect_lane_rankings(&query, ctx.personal.as_ref().unwrap())?;
    let unified = merge_lane_rankings(cwd_lanes, personal_lanes); // cwd-wins on dedup
    let weights = query.weights.clone().unwrap_or_default();
    let fused = rrf(&unified, weights.k);
    build_hits(query, fused, &ctx.cwd, ctx.personal.as_ref())
}
```

Requires refactoring `recall()` to expose `collect_lane_rankings` as a
helper; W9 will need that anyway when it adds per-source attribution to
`WhyHit`.

---

### F5 — `extract_excerpt` slices `body` with byte indices from `body.to_lowercase()`; panics on case-changing UTF-8
**File:** `crates/pi-knowledge-core/src/recall.rs:300-326`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** CORRECTNESS / PANIC

```rust
let lower_body = body.to_lowercase();
let lower_query = query.to_lowercase();
if let Some(pos) = lower_body.find(&lower_query) {
    // pos is a byte offset into LOWER_BODY
    let start = pos.saturating_sub(50);
    let end = (pos + lower_query.len() + 150).min(body.len());
    let excerpt: String = body[start..end].to_string();   // ← slices ORIGINAL body
```

`String::to_lowercase` is allowed to change byte length: German `ß` (2 B,
0xC3 0x9F) lowercases to `ss` (2 B identical); but `ẞ` (capital sharp s,
3 B) lowercases to `ß` (2 B); Turkish `İ` (2 B, U+0130) lowercases to `i\u{307}`
(3 B). Any tasks/.org or .spell/memory item containing such characters in
its body — likely in a multilingual concept node, a quoted error message,
or a non-ASCII identifier — produces `pos` and `lower_query.len()` measured
in the *lowercased* byte layout, which then index into the *original* body
bytes. Two failure modes:

1. `body[start..end]` straddles a non-char boundary → **panic**, NAPI
   surfaces it as `napi::Error`, the entire recall request fails.
2. The slice lands on a valid boundary but spans the wrong substring →
   excerpt is silently corrupted/misaligned.

Unit tests at `recall.rs:660+` are ASCII-only; clippy can't catch it; this
will only blow up at runtime on the first non-ASCII corpus.

**Suggested fix:** keep `lower_body` only to *locate* the match, but
convert the byte position back via char iteration on the original — or
simpler, use `char_indices` on the original to find a case-insensitive
match site, then slice around char boundaries:

```rust
// crates/pi-knowledge-core/src/recall.rs:303 (replacement)
#[must_use]
pub fn extract_excerpt(body: &str, query: &str) -> String {
    let query = query.trim();
    if query.is_empty() { return body.chars().take(200).collect(); }
    // Locate case-insensitive match in the original body via char-aligned scan.
    let lower_query = query.to_lowercase();
    let needle_chars: Vec<char> = lower_query.chars().collect();
    let mut match_char_idx: Option<usize> = None;
    let chars: Vec<char> = body.chars().collect();
    'outer: for i in 0..chars.len().saturating_sub(needle_chars.len() - 1) {
        for (j, nc) in needle_chars.iter().enumerate() {
            let bc = chars[i + j].to_lowercase().next().unwrap_or(chars[i + j]);
            if bc != *nc { continue 'outer; }
        }
        match_char_idx = Some(i); break;
    }
    let Some(start_char) = match_char_idx else {
        return body.chars().take(200).collect();
    };
    let start = start_char.saturating_sub(50);
    let end   = (start_char + needle_chars.len() + 150).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 { s.insert_str(0, "..."); }
    s
}
```

Plus a regression test: `extract_excerpt("Über die ß-Regel", "ß")` should
not panic and should return a recognisable excerpt.

---

### F6 — `ingest::classify` defaults to `Modified` for `EventKind::Access` + `Other`; will fire spurious rebuilds on macOS FSEvents
**File:** `crates/pi-knowledge-core/src/ingest.rs:236-256`
**Confidence:** HIGH
**Severity:** MEDIUM
**Class:** PERF / OPERATIONAL / W7-BLOCKER

```rust
match raw {
    EventKind::Create(_)   => /* … */,
    EventKind::Modify(kind) => /* … */,
    _ => if known { IngestEventKind::Modified } else { IngestEventKind::Created },
}
```

The catchall swallows `EventKind::Access(_)`, `EventKind::Other`, and
`EventKind::Any`. On macOS, FSEvents conflates several lifecycle bits into
synthetic events; Linux `inotify` doesn't emit access events by default but
`IN_ACCESS` is reachable when watcher is configured for it. Once W7
producers run a hot loop (compaction + episode writes) under a watched
root, every file *read* (cat / grep / a sibling tool) could classify as
`Modified` → debounce coalesces → callback fires → full rebuild
(`recall_engine::ensure_warm` walks the corpus, re-parses, re-embeds).
Cost: one wasted ~3-5s rebuild per spurious tick.

Compounding: there is **no cache-dir exclusion**. `_cache_dir: &Path` is
explicitly unused (line 109, `#[allow(clippy::needless_pass_by_value)]`).
If W7 wires the cache dir under `.spell/recall/<repo-hash>/` inside the
watched root (the obvious default — see `repo_cache_dir`), every cache
write triggers a watch event triggers a rebuild triggers a cache write —
unbounded feedback loop. The fact that `_cache_dir` is *accepted* by the
signature but ignored is a foot-gun: any caller will reasonably assume
it's used.

**Suggested fix:** (a) make the classify match exhaustive and ignore
`Access(_)` and `Other`; (b) honour `cache_dir` as an exclusion prefix.

```rust
// crates/pi-knowledge-core/src/ingest.rs:236
const fn classify_opt(raw: EventKind, exists: bool, known: bool) -> Option<IngestEventKind> {
    if !exists {
        // notify saw a remove or the file vanished between the FS event and the tick.
        return Some(IngestEventKind::Deleted);
    }
    match raw {
        EventKind::Create(_) | EventKind::Modify(_) => Some(if known {
            IngestEventKind::Modified
        } else {
            IngestEventKind::Created
        }),
        EventKind::Remove(_) => None, // racy; rely on next tick's existence check
        EventKind::Access(_) | EventKind::Other | EventKind::Any => None,
    }
}

// crates/pi-knowledge-core/src/ingest.rs:102 (signature unchanged, body):
let cache_prefix = _cache_dir.to_path_buf();
// inside drain_settled loop, before classify:
if path.starts_with(&cache_prefix) { continue; }
```

Add a test that writes to a path inside `cache_dir` and asserts no event
fires.

---

### F7 — `build_vec_index` panics on `VectorIndex::new` failure → NAPI process crash
**File:** `crates/pi-natives/src/recall_engine.rs:506-509`
**Confidence:** HIGH
**Severity:** MEDIUM
**Class:** RELIABILITY / NAPI-SURFACE

```rust
fn build_vec_index(items: &[OrgItem]) -> VectorIndex {
    let mut vec = VectorIndex::new(DIM, items.len().max(1))
        .unwrap_or_else(|e| panic!("vec index init failed: {e}"));
```

`VectorIndex::new` can fail (usearch reserve OOM, malformed options).
Panics in a NAPI-linked .so propagate as a process abort across the FFI
boundary (Bun's main thread dies). The rest of `recall_engine` is careful
to bubble errors through `Result<…, String>` — this site is the only `panic!`
in the rebuild path. Cheap to fix: thread the error.

**Suggested fix:** change the helper return to `Result<VectorIndex, String>`
and propagate; the caller in `full_rebuild` is already in the engine state-
machine where errors flow back.

```rust
// crates/pi-natives/src/recall_engine.rs:506
fn build_vec_index(items: &[OrgItem]) -> Result<VectorIndex, String> {
    let mut vec = VectorIndex::new(DIM, items.len().max(1))
        .map_err(|e| format!("vec init: {e}"))?;
    if items.is_empty() { return Ok(vec); }
    // …existing body…
    Ok(vec)
}

// crates/pi-natives/src/recall_engine.rs:262 (full_rebuild)
fn full_rebuild(&self, fp: WorkspaceFingerprint) -> Result<WarmEngine, String> {
    let items = scan_items(&self.repo_root);
    let docs  = project_docs(&items);
    let bm25  = SearchIndex::from_docs(&docs);
    let vec   = build_vec_index(&items)?;
    let graph = build_typed_graph(&items);
    Ok(WarmEngine { fingerprint: fp, items, docs, bm25, vec, graph })
}
```

---

## Summary — HIGH-confidence findings ranked

| # | Title | Severity | Class |
|---|---|---|---|
| F1 | Hot recall path swallows 3 error classes → zero-vec query + silent vector-lane disable | MAJOR | API / OPERATIONAL |
| F2 | `recall_engine` cache bypasses `KnowledgeMeta` + `purge_if_stale`; embedder swap serves stale vectors | MAJOR | CROSS-WAVE / PERSIST |
| F3 | `RecallQuery::profile` is parsed but `recall()` never reads it; `"session-start"` profile is also hollow | MAJOR | API / CONTRACT |
| F4 | `recall_dual` fuses two RRF outputs by incommensurate raw scores; W9 ordering will be wrong | MAJOR | ALGORITHM / W9 |
| F5 | `extract_excerpt` slices original body with lowercase-byte offsets; panics on case-changing UTF-8 | MAJOR | CORRECTNESS / PANIC |
| F6 | `ingest::classify` defaults `Access/Other` → `Modified`; no `cache_dir` exclusion → feedback loop | MEDIUM | PERF / W7-BLOCKER |
| F7 | `build_vec_index` panics on `VectorIndex::new` failure → NAPI process abort | MEDIUM | RELIABILITY |

**The convergence itself is sound** — the deleted-crate diff is real, the
edge-type unification through `pi_org_engine::graph::TypedGraph: RecallGraph`
is clean, `id_hash` is the right primitive, and the `recall.rs` API shape
(`RecallDoc` / `RecallContext` / `RecallQuery` / `WhyHit`) is the right
factoring for W4's unified-graph world. The HIGH findings cluster on two
themes: error swallowing (F1, F5, F7) and convergence-not-finished (F2, F3,
F6 partly) — both can be fixed inside `pi-knowledge-core` + `recall_engine`
without touching `vec.rs`, `bm25.rs`, or `ingest.rs` public surfaces.

F2 + F3 share a wave-shape question: **W7 producers should consume
`purge_if_stale` and `RecallProfileRegistry`**. Landing the wiring in
W5.5-gaps (one rev of `recall_engine.rs` + a `RecallProfileRegistry`
parameter on `recall()`) avoids W7 inheriting both gaps as design questions
during a wave that's already heavy on episode-write surface.

## Deferred to FUP

- **`RecallContext` is single-shot; W6's `memory.{search|about|neighbors}`
  needs ≥3 entry points but only `recall()` exists.** `about(id)` and
  `neighbors(id, hops, kinds)` are derivable from the context's docs +
  graph fields, but no public helper exposes them. W6 will either call
  `recall()` with abusive arg shapes (text=id, weights={bm25:0,vector:0,
  graph:1}) or reach inside `WarmEngine`. Add `fn about(id, ctx)` and
  `fn neighbors(id, hops, kinds, ctx)` to `recall.rs` once W6's request
  shape is finalised. Class: API / W6.
- **`ENGINES_CAP = 1`** in `recall_engine.rs:67`. Any two-repo workflow
  (working tree + sibling personal store, or just `cd ../other-repo`) pays
  a full cold restore on switch. With ≥2 the LRU eviction logic is
  already wired (`Arc::strong_count == 1` guard at line 183 handles
  in-flight handles), so bumping the cap is one-line. Class: PERF / UX.
- **No symlink-cycle protection in `walk_org_files` / `collect_fingerprints`**
  (`recall_engine.rs:486-502`, `560-590`). A repo with a symlink loop in
  `!tasks/` will infinite-recurse. `walkdir` (already a transitive dep
  via `notify`) has built-in cycle guarding; switch from `fs::read_dir`
  to `walkdir::WalkDir::new(dir).follow_links(false)`. Class: RELIABILITY.
- **`recall_engine` recomputes `compute_fingerprint` on every query**
  (~5ms / 1870 files per `recall_engine.rs:26`). The ingest watcher could
  flip a per-handle `dirty: AtomicBool`; warm queries then skip the FS
  walk entirely. The wiring is "subscribe to `watch_and_rebuild` at
  engine creation, set dirty on event"; ~30 LOC. Pays off the W7 latency
  budget. Class: PERF / CROSS-WAVE.
- **`recall.rs:506` `ctx.personal.as_ref().unwrap()`** is reachable only
  after the prior-line `is_none()` guard, but `if let Some(personal) =
  ctx.personal.as_ref()` reads cleaner and survives a future refactor
  that drops the early-return. Class: STYLE.
- **`WhyHit` is missing per-lane *contribution* (a float weight share),
  not just per-lane *rank*.** The agent prompt's "why was this returned"
  rationale wants "vector lane gave this 0.012 of the 0.018 fused score"
  — currently has to be re-derived. Add `bm25_contribution: Option<f32>`
  etc. to `WhyHit`, fill at fusion time. Class: API / OBSERVABILITY.
- **`scope: Vec<String>` semantics**: empty = match-all, non-empty =
  whitelist. No way to express exclusion. For W9's "search cwd minus
  personal" or W6's "exclude episodes older than 30d" no expressive
  primitive exists. Eventually grow `RecallScope { include: Vec<String>,
  exclude: Vec<String> }`. Class: API.
- **`RecallQuery::graph_kinds: Vec<EdgeKind>`** — passing an empty vec
  means "any kind" (good default), but the type doesn't communicate that.
  `Option<Vec<EdgeKind>>` would. Class: NAMING.
- **`FusionWeights` defaults `{ bm25: 0.3, vector: 0.5, graph: 0.2,
  k: 60 }`** are reasonable for W6/W7 generic search but biased toward
  vector — when the embedder is *down* (F1 surfaces it as zero hits), the
  effective fusion shifts to 30% bm25 + 20% graph = 50% of intended signal.
  Document this as an explicit invariant ("vector weight reflects intent,
  not availability; lane-status flags should be consulted by callers
  scoring fusion quality"). Class: DOCS / API.
- **`pi-embedding-worker::engine.rs::EmbeddingEngine`** ships an `unsafe
  impl Sync` (line 22) on the wrapper. The `Mutex<TextEmbedding>` is
  *itself* `Sync`-by-construction; the explicit `unsafe impl` here is
  redundant and weakens reviewability by making the file look like it has
  a real soundness hole. Drop it; rely on the auto-derived `Sync` from
  `Mutex<T>`. Class: SAFETY / CLARITY.
- **The two `pi_org_recall` mentions remaining**
  (`crates/pi-knowledge-core/src/cache.rs:90`,
  `crates/pi-knowledge-core/src/recall.rs:3,117`) are doc-comment
  archaeology. Harmless but worth a one-line scrub for W11 docs hygiene
  — the comments now describe a crate that doesn't exist. Class: DOCS.
- **`recall_engine` `OnceLock<Mutex<Vec<LruEntry>>>` is process-global
  state** — fine today since pi-natives runs in one Bun process, but W3's
  socket world hints at out-of-process supervisors. If the daemon ever
  hosts the engine, the singleton becomes a contention chokepoint. Plan a
  `RecallEngine::new()` constructor as the public seam now; keep
  `get_or_create` as a convenience over `Default`. Class: ARCHITECTURE.
- **W11 docs: nothing in this wave is documented externally** —
  `RecallDoc`, `RecallQuery`, `RecallContext`, the `FusionWeights`
  semantics, the `purge_if_stale` contract, the `id_hash` collision
  guarantee. Pick the 4-5 most agent-facing surfaces and draft a
  `docs/pi-knowledge-core.md` ahead of W11. Class: DOCS.
