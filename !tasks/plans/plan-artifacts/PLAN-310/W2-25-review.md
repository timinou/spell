# PLAN-310 W2.25 — Review of usearch swap-in + code-graph migration

> Reviewer: forward-looking surface audit (read-only). W2 lands a clean
> `pi-knowledge-core::vec::VectorIndex` on usearch and migrates `pi-code-graph`
> + `pi-natives::code_graph` onto it. Tests are green and the crate compiles.
> Question on the table: will this hold up when W2.5 (bge-m3, 1024-dim),
> W3 (user-scoped embedder), W4 (org-engine onto same `vec.rs`), W5
> (notify-driven ingest + delete `pi-org-recall`) wire in?

Findings ranked by confidence × severity. The surface is largely sound — the
`VectorIndex` abstraction is small, the metric-conversion is correct, and
`view()` cleanly enables the cross-session sharing pattern W3 wants. The
issues below are all about *integration shape* for the upcoming waves, not
about W2 behaviour today.

---

### F1 — Vector cache fingerprint ignores embedder model/dim; W2.5 bge-m3 swap won't invalidate
**File:** `crates/pi-natives/src/code_graph.rs:404-471` (save_vector_cache + load_vector_cache + read_fingerprint)
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** CROSS-WAVE / PERSIST

`save_vector_cache` writes only the graph fingerprint (`u64` hash of
`GraphCacheEntry::fingerprint`, which is files + git_head — see
`graph_fingerprint_hash` line 403). `load_vector_cache` matches on that hash
alone. When W2.5 swaps `EmbeddingModel::JinaV2` (768-dim) for `BGEM3`
(1024-dim) on an unchanged workspace, the graph fingerprint is byte-identical,
the `.fp` sidecar matches, `load_vector_cache` returns `Fresh`, and the
cached 768-dim `.uidx` is handed to `graph_search` which calls
`vector_index.search(qv, ...).unwrap_or_default()` at
`crates/pi-code-graph/src/query.rs:162`. The new 1024-dim query vector vs
768-dim index trips `vec.rs::search` line 92 (`dim mismatch on query: expected
768, got 1024`); `unwrap_or_default()` swallows it to an empty vec, and
semantic search silently degrades to BM25-only **forever** — until the user
manually re-runs `code index --semantic`. W1.5 already shipped
`KnowledgeMeta::status_against(current, expected_model, expected_dim)` in
`crates/pi-knowledge-core/src/cache.rs:48-79` to fix exactly this; code-graph
doesn't use it. The W1.5 fields `embedder_model` and `embedder_dim` sit dead
until somebody wires them through.

**Suggested fix:** Persist the embedder model+dim alongside the graph
fingerprint and reject on mismatch at load. Minimal change: extend the `.fp`
sidecar from `u64` to a `KnowledgeMeta`-shaped blob, or (cleaner) call
`VectorIndex::metadata(&path)` post-load to compare dim against expected.

```rust
// crates/pi-natives/src/code_graph.rs:438 (load_vector_cache)
fn load_vector_cache(
    cache: &CacheStore,
    expected_hash: Option<u64>,
    expected_dim: usize,   // ← new, supplied by caller from embedder
) -> VectorCacheState {
    // … existing path-existence + load …
    if vectors.dim() != expected_dim {
        return VectorCacheState::Stale(vectors);  // forces silent rebuild path
    }
    // … existing fingerprint comparison …
}
```

W5 should converge this onto `KnowledgeMeta::status_against(..)` (see F3).

---

### F2 — Sidecar `.fp` (u64 LE) duplicates `KnowledgeMeta`; two persistence shapes will collide at W5
**File:** `crates/pi-natives/src/code_graph.rs:25-27, 420-447`; `crates/pi-knowledge-core/src/cache.rs:23-83`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** PERSIST / CROSS-WAVE

W2 ships a per-cache sidecar (`workspace-vectors.fp`, 8 raw u64 LE bytes)
that encodes one thing: a `DefaultHasher` digest of the graph fingerprint.
W1.5 already shipped `KnowledgeMeta` (`schema_version`, full
`WorkspaceFingerprint`, `built_at`, `embedder_model`, `embedder_dim`) backed
by bincode + `save_all`. These are two parallel cache invariants — the .fp
is strictly less expressive (no schema version → can never invalidate on
format bumps, no embedder metadata → F1), and `KnowledgeMeta` doesn't see
the vector index. When W5 lands the notify-driven ingest + retires
`pi-org-recall`, it'll want one cache shape across both code-graph and
memory; perpetuating both forces W5 to either delete .fp (back-compat
churn) or rebuild meta.bin shape (and migrate every existing user). The
right cutover is to retire .fp now and write a `KnowledgeMeta` blob into
`.spell/graph/` next to `workspace.bin`, with `embedder_model`/`embedder_dim`
populated.

**Suggested fix:** in `crates/pi-natives/src/code_graph.rs:420`, replace the
.fp scheme with a `KnowledgeMeta` write:

```rust
// crates/pi-natives/src/code_graph.rs:420 (save_vector_cache)
fn save_vector_cache(
    cache: &CacheStore,
    vectors: &pi_knowledge_core::vec::VectorIndex,
    fingerprint: &WorkspaceFingerprint,
    embedder_model: &str,
) -> napi::Result<()> {
    let mut meta = KnowledgeMeta::new(fingerprint.clone());
    meta.embedder_model = embedder_model.into();
    meta.embedder_dim = vectors.dim();
    pi_knowledge_core::cache::save_all(cache, vec![
        ("workspace-vectors", Box::new(|w| { /* usearch .uidx is binary; keep .uidx alongside */ Ok(()) })),
        ("workspace-vector-meta", Box::new(|w| Ok(bincode::serialize_into(w, &meta)?))),
    ])
}
```

(Note that usearch's `.save()` is binary-blob and doesn't compose with
bincode-`save_all`; keeping `.uidx` separate is fine — what's removable is
the `.fp`.)

---

### F3 — `save_vector_cache` skips W1.5's `save_all`; partial writes leave a "Stale" cache that's actually fresh
**File:** `crates/pi-natives/src/code_graph.rs:420-447`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** PERSIST / API

Two-step persist: `vectors.save(&index_path)` (atomic via `vec.rs` tmp+rename
at `crates/pi-knowledge-core/src/vec.rs:120-127`), then a separate
`fs::write(&tmp_fp, ...)` + `fs::rename(&tmp_fp, &fp_path)`. The two renames
aren't transactional. Failure modes:

1. `.uidx` committed, `.fp` write fails → next load: `read_fingerprint`
   returns None → `load_vector_cache` returns `Stale(vectors)`. The vectors
   are actually freshly written but the path mis-classifies them. With
   `semantic: true` the search returns an error
   ("Semantic search requested but unavailable... Run `code index` with
   semantic: true first") — operationally annoying, not corrupt.
2. Process killed between the two ops: same as (1).

This is precisely the multi-blob race that W1.5's
`pi_knowledge_core::cache::save_all` (lines 134-181 of cache.rs) was built
to fix — stage everything to `.tmp`, only rename after every write succeeds,
caller orders `meta` last. Code-graph diverges by reinventing a thinner
variant. Beyond the operational pothole, the API divergence means W4
(org-engine retarget) and W5 (notify ingest) will face the same pattern fork:
which crate is the source of truth for atomic-multi-blob? Land convergence
now.

**Suggested fix:** Use `save_all` for the meta sidecar (the `.uidx` itself is
already atomic via usearch's tmp+rename in `vec.rs`):

```rust
// crates/pi-natives/src/code_graph.rs:420
fn save_vector_cache(
    cache: &CacheStore,
    vectors: &pi_knowledge_core::vec::VectorIndex,
    meta: &KnowledgeMeta,
) -> napi::Result<()> {
    vectors.save(&cache.directory().join("workspace-vectors.uidx"))?;
    pi_knowledge_core::cache::save_all(cache, vec![
        ("workspace-vectors-meta", Box::new(move |w| {
            bincode::serialize_into(w, meta).map_err(Into::into)
        })),
    ])?;
    Ok(())
}
```

(F2 and F3 converge: one rewrite covers both.)

---

### F4 — `score = 1.0 − distance` is correct *only* for cosine metric, but the contract is untyped
**File:** `crates/pi-knowledge-core/src/vec.rs:48-58, 98-104`
**Confidence:** MEDIUM
**Severity:** MINOR
**Class:** API / NAMING

`VectorIndex::new` hard-codes `metric: MetricKind::Cos` and `quantization:
ScalarKind::F32`. Search returns `score: 1.0_f32 - d` — that's similarity ∈
[-1, 1] for cosine distance, but the same formula yields meaningless values
for `L2sq`, `Hamming`, `Tanimoto`, etc. W4 (org-engine on the same `vec.rs`)
or any future tuning pass that flips `metric` to L2 will silently corrupt
the score semantics, and the test `score_is_similarity_not_distance` only
exercises Cos. Either make the metric a constructor parameter and derive the
conversion (`Cos: 1 - d`, `L2sq: -d` or `1 / (1+d)`, etc.) or document the
fixed-metric contract inline at the `score` field and the `1.0 - d` site.

**Suggested fix:** lock the contract with a doc comment + a debug assertion
at the only place metric is set.

```rust
// crates/pi-knowledge-core/src/vec.rs:14 (VectorSearchHit)
/// Cosine similarity in [-1, 1] (higher = more similar).
/// NB: the (1.0 - distance) conversion below is only valid because
/// `VectorIndex::new` hard-codes MetricKind::Cos. Changing the metric
/// requires updating both call sites.
pub score: f32,
```

Or — better — introduce `metric: Metric` to `VectorIndex::new` now (kept at
default `Cos`) so W4 has a parameterised entry-point.

---

### F5 — Cross-process mmap "stress" test is single-process; W2 gate ("`vectors.uidx` cross-process read test passes") is unmet in spirit
**File:** `crates/pi-knowledge-core/tests/vec_mmap_stress.rs:24-58`
**Confidence:** MEDIUM
**Severity:** MAJOR
**Class:** TEST / CROSS-WAVE

PLAN-310 W2 gate language: "*vectors.uidx cross-process read test passes*".
`two_view_handles_read_same_results` opens two `VectorIndex::view()` handles
within one process and threads queries across them — that exercises shared
mmap *inside* a process, but `usearch::Index::restore_view` is a per-process
mmap, and the failure modes worth catching (one process writes via
tmp+rename while another holds a view; kernel-level mmap unmap on
unlink-of-inode; cross-process page cache sharing — the very behaviour that
makes W3's user-scoped embedder + shared cache attractive) only manifest
across `fork`/`exec` boundaries. The current test wouldn't fail if usearch
silently fell back to a private RAM copy. W3 is the user-scoped wave; pin
the contract before then so the regression catches the right boundary.

**Suggested fix:** Add a real subprocess test (writer in test, reader spawned
via `Command::new(std::env::current_exe()).args(["--exec", "view_path"])` +
an env-var-gated inner-main) that asserts identical top-K results from a
child process opening the same `.uidx`. Pattern is in heavy use across
`cargo test` suites — see `crates/pi-natives/src/test-bin/` for the existing
mock-worker shape.

---

### F6 — `vec.rs` exposes per-key `remove` only; W5 incremental ingest needs bulk-by-source semantics
**File:** `crates/pi-knowledge-core/src/vec.rs:89-91`
**Confidence:** MEDIUM
**Severity:** MINOR
**Class:** API / CROSS-WAVE

W5 will run notify-driven ingest: file F changes → remove every vector
derived from F's chunks → re-embed F's new chunks → upsert. Today, `node_id`
is a `u64` (`chunk.node_index as u64` at
`crates/pi-natives/src/code_graph.rs:387`) with no back-reference to its
source file. The ingest loop has to maintain an external `BTreeMap<PathBuf,
Vec<u64>>` to know which `remove` calls to issue, *and* keep that map in
sync with the .uidx. Two stores of the same fact; the `KnowledgeMeta` /
graph fingerprint shape can't help (it tracks files only, not file→node_id).
Either accept the responsibility in `vec.rs` (grow a parallel `BTreeMap<u64,
SourceTag>`, expose `remove_by_source(&SourceTag) -> usize`) or document
explicitly that the caller owns the inverse map and W5 ingest must persist
it alongside `meta.bin`.

**Suggested fix:** Document the contract now and pin a `remove_many` helper
that batches the contains-check + remove loop (small perf win; clearer
W5-ergonomic signature):

```rust
// crates/pi-knowledge-core/src/vec.rs:91
/// Remove a batch of keys. Missing keys are ignored. Callers are responsible
/// for maintaining the source→keys inverse map (vec.rs is dimension-agnostic
/// and intentionally doesn't know about source files / chunks / org items).
pub fn remove_many<I: IntoIterator<Item = u64>>(&mut self, ids: I) -> Result<usize> {
    let mut removed = 0;
    for id in ids {
        if self.inner.contains(id) {
            self.inner.remove(id).map_err(usearch_err)?;
            removed += 1;
        }
    }
    Ok(removed)
}
```

---

### F7 — `from_entries` clones every entry; one wasted full-corpus allocation
**File:** `crates/pi-knowledge-core/src/vec.rs:60-66`
**Confidence:** MEDIUM
**Severity:** MINOR
**Class:** PERF

```rust
pub fn from_entries(entries: &[VectorEntry], dimensions: usize) -> Result<Self> {
    let mut idx = Self::new(dimensions, entries.len().max(1))?;
    for e in entries {
        idx.upsert(e.clone())?;     // ← clone is unavoidable today
    }
    Ok(idx)
}
```

`upsert` takes `entry: VectorEntry` by value; `from_entries` borrows the
slice, so it must clone. At 10k vectors × 1024 dims × 4 B that's a ~40 MB
copy that exists just to be moved into `usearch::Index::add` which copies
*again* into its internal storage. usearch's `add(key, &[f32])` already
takes by reference; threading `&[f32]` through both APIs eliminates one
40-MB pass on cold semantic index build (which is the latency W5.5 will
benchmark against the 90s gate).

**Suggested fix:** Accept the entries by value (move) in `from_entries`, or
add a `pub fn add(&mut self, node_id: u64, vector: &[f32]) -> Result<()>`
parallel-API that `from_entries` uses directly:

```rust
// crates/pi-knowledge-core/src/vec.rs:67
pub fn add(&mut self, node_id: u64, vector: &[f32]) -> Result<()> {
    if vector.len() != self.dim { return Err(/* … */); }
    if self.inner.contains(node_id) { self.inner.remove(node_id).map_err(usearch_err)?; }
    // capacity grow as today
    self.inner.add(node_id, vector).map_err(usearch_err)?;
    Ok(())
}

pub fn from_entries(entries: &[VectorEntry], dimensions: usize) -> Result<Self> {
    let mut idx = Self::new(dimensions, entries.len().max(1))?;
    for e in entries { idx.add(e.node_id, &e.vector)?; }
    Ok(idx)
}
```

---

### F8 — Pre-W2 `vectors.bin` orphans never cleaned up
**File:** `crates/pi-natives/src/code_graph.rs:404-471` (no cleanup helper); migration omitted from PLAN-310 W2
**Confidence:** MEDIUM
**Severity:** MINOR
**Class:** PERSIST

Pre-W2, the vector cache lived at `.spell/graph/workspace-vectors.bin`
(bincode); W2 writes `.uidx` instead and never deletes the legacy `.bin`.
Every developer machine that ran a pre-W2 build keeps a stale `vectors.bin`
in their cache dir forever (the file size is bounded but the smell isn't —
W5's notify watcher will trip on it as an unrecognised file in
`.spell/graph/`, and any future "diagnose stale caches" surface will have
to ignore-list it). Cheap one-shot fix: `fs::remove_file` legacy paths
during `save_vector_cache` and document in CHANGELOG.

**Suggested fix:**

```rust
// crates/pi-natives/src/code_graph.rs:421 (top of save_vector_cache)
const LEGACY_VECTORS_FILE: &str = "workspace-vectors.bin";
let _ = fs::remove_file(cache.directory().join(LEGACY_VECTORS_FILE));
```

(Strict best-effort: an ENOENT or PermissionDenied here must not fail the
save.)

---

## Summary — HIGH-confidence findings for W2.25-gaps

| # | Title | Severity |
|---|---|---|
| F1 | Vector cache fingerprint ignores embedder model/dim — W2.5 will silently serve stale 768-dim cache | MAJOR |
| F2 | `.fp` sidecar duplicates `KnowledgeMeta`; two parallel persistence shapes will collide at W5 | MAJOR |
| F3 | `save_vector_cache` skips W1.5's `save_all`; partial-write race leaves a "Stale"-tagged fresh cache | MAJOR |

These three converge on one rewrite of `save_vector_cache` /
`load_vector_cache` in `crates/pi-natives/src/code_graph.rs`: retire the
`.fp` sidecar, persist a `KnowledgeMeta` via `pi_knowledge_core::cache::save_all`,
populate `embedder_model` + `embedder_dim`, and rely on
`KnowledgeMeta::status_against(current, expected_model, expected_dim)` at load.
Land this in W2.25-gaps before W2.5 ships bge-m3 — fixing it after the
embedder swap is migration churn rather than a clean cutover.

## Deferred to FUP

- **F4** — Score conversion `1.0 - d` is correct for `Cos` only; lock the
  contract with a doc comment or thread `Metric` through `VectorIndex::new`.
  Class: API / NAMING. Not blocking W2.5/W3.
- **F5** — Single-process mmap "stress" test doesn't exercise the real
  cross-process boundary. Worth a subprocess-style test before W3's
  user-scoped embedder lands. Class: TEST.
- **F6** — `vec.rs` exposes only per-key `remove`; W5 ingest will need
  bulk-by-source semantics. Document the source→keys inverse-map contract
  and add a `remove_many` batch helper. Class: API / CROSS-WAVE.
- **F7** — `from_entries` clones each entry (one wasted full-corpus
  allocation at ~40 MB cold). Add a `&[f32]`-taking `add()` to compose
  cleanly. Class: PERF.
- **F8** — Pre-W2 `vectors.bin` never cleaned up; one-shot `fs::remove_file`
  in `save_vector_cache` suffices. Class: PERSIST.
- **Vector index errors silently swallowed at search site** —
  `crates/pi-code-graph/src/query.rs:162` does
  `vector_index.search(qv, limit * 2).unwrap_or_default()`; a usearch
  exception or dim mismatch becomes "no vector hits" with no telemetry.
  Once F1 lands (which exposes one class of mismatch as a `Stale` state),
  this site should at minimum log the underlying error rather than
  drop it. Class: API.
- **`VectorIndex` stores `dim` twice** (struct field + `inner.dimensions()`).
  Trivially desyncable if anyone tweaks the constructor. Drop the field
  and delegate. Class: NAMING.
- **`upsert`'s contains→remove→add pattern** is single-process race-safe
  via `&mut self` but undefined across two writer processes against the
  same `.uidx`. Document in the `VectorIndex` doc comment: "single writer,
  multiple `view()` readers; concurrent writers are UB." Class: API.
- **node_id `u64 → usize` cast** at
  `crates/pi-code-graph/src/hybrid.rs:73` panics in debug on 32-bit; Spell
  is 64-bit so cosmetic. Class: PERF.
- **`metadata()` returns `(usize, usize)` for `(dim, count)`** — a
  named struct would be self-documenting and survive a future
  `count_deleted` field. Class: NAMING.
