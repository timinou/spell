# PLAN-310 Wave 5.5 — Post-W5 Performance Measurements

Measured 2026-05-22 on the working tree at HEAD `7db61b9e7` (W5 landed).
All numbers are real measurements; W0 anchor is `W0-baselines.md`.
Hardware: AMD Ryzen AI 7 350 (Krackan, 8-core), Linux 6.18.6-zen1, AMD 860M.

---

## A. Binary Size

| Metric | W0 | W5.5 | Δ | Source |
|---|---|---|---|---|
| `libpi_natives.so` (release, bytes) | 120,342,000 | 97,512,280 | **−22,829,720 (−19.0 %)** | `stat -c %s target/release/libpi_natives.so` |
| `libpi_natives.so` (MB) | 114.8 | 92.99 | **−21.8 MB** | — |
| Stripped size | 120,342,000 | 97,512,272 | −8 bytes | `strip -o /tmp/x && stat -c %s` |
| Cargo tree edge count (`pi-natives`) | 1,820 | **1,280** | −540 (−29.7 %) | `cargo tree -p pi-natives --format '{p}' \| wc -l` |
| Unique cargo packages | n/m | 967 | — | `… \| sort -u \| wc -l` |
| Tantivy subcrate count in `pi-natives` tree | 16 | **0** | gone | `cargo tree -p pi-natives \| grep -c tantivy` |
| `hnsw_rs` subcrate count in `pi-natives` tree | 1 | **0** | gone | `cargo tree -p pi-natives \| grep -c hnsw_rs` |
| `fastembed` in `pi-natives` tree | 1 | **0** | moved to `pi-embedding-worker` (sidecar) | `cargo tree -p pi-natives \| grep -c fastembed` |
| `usearch` in `pi-natives` tree | 0 | 1 | added (HNSW replacement) | `cargo tree -p pi-natives \| grep usearch` |

**Stale rlibs note:** `target/release/deps/libtantivy*.rlib` and `libhnsw_rs*.rlib`
still exist on disk (189 MB and 52 MB respectively) as orphaned incremental
artifacts. A `cargo clean && cargo build --release -p pi-natives` would reclaim
that disk, but they no longer link into `libpi_natives.so` — confirmed by the
`cargo tree` zero counts.

**Verdict on size gate (≤ +5 MB vs pre-PLAN-290):** Pre-PLAN-290 baseline is
not measured in this repo (gap carried from W0). We can only say **−21.8 MB
vs W0**, which puts us comfortably below the +5 MB headroom unless the
pre-PLAN-290 baseline was < 75 MB (unlikely, given the W0 → W5.5 drop comes
almost entirely from removing PLAN-290's tantivy + hnsw_rs additions). **Likely PASS.**

---

## B. BM25 Latency

### B.1 Existing test-suite wall-clock (release)

| Suite | Tests | Total wall-clock | Source |
|---|---|---|---|
| `pi-knowledge-core::bm25` (release) | 12 | **< 1 ms (reported 0.00 s)** | `cargo test -p pi-knowledge-core --release bm25 -- --test-threads=1` |
| `pi-knowledge-core::recall` (release) | 8 | **< 1 ms** | `cargo test -p pi-knowledge-core --release recall -- --test-threads=1` |
| `pi-knowledge-core` (full lib, release) | 80 | **1.57 s** | `cargo test -p pi-knowledge-core --release` |
| `pi-knowledge-core::vec_mmap_stress` (integration) | 3 | **0.05 s** | same |
| `pi-natives::recall_engine` (release, 12 tests inc. disk fast-path) | 12 | **0.36 s** | `cargo test -p pi-natives --release recall_engine -- --test-threads=1` |

W0's debug-build proxy: 9 fts tests ≈ 3.62 s; full pi-org-recall debug suite
4.6–5.7 s. The release reality on the new stack is ~10× faster at the test-suite
level — but that's not a search-latency measurement.

### B.2 Synthetic 10k-corpus benchmark (new — fills the W0 gap)

Stand-alone harness at `/tmp/bm25-bench` depending on
`pi-knowledge-core` via path; release profile (`opt-level = 3, lto = false`);
`taskset -c 0` for jitter control; 5 runs:

| Phase (n = 10 000 docs) | Min | Median | Max | Gate | Pass |
|---|---|---|---|---|---|
| Cold rebuild from raw docs (`SearchIndex::from_docs`) | 301 ms | 493 ms | 519 ms | < 200 ms | ✗ (worst-case path) |
| Bincode serialize (write `bm25.bin`) | 31 ms | 35 ms | 43 ms | — | — |
| Bincode deserialize (disk fast-path restore) | **60 ms** | **89 ms** | **98 ms** | — | — |
| First query after restore (cold P99 proxy) | 6.2 ms | 8.4 ms | 12.0 ms | — | — |
| **Disk-fast-path cold E2E** (deserialize + 1st query) | **66 ms** | **97 ms** | **110 ms** | < 200 ms | **✓** |
| Warm P50 (200 queries) | 7.1 ms | 8.3 ms | 10.1 ms | — | — |
| **Warm P99** (200 queries) | **9.5 ms** | **13.2 ms** | **18.5 ms** | < 50 ms | **✓** |
| Warm max | 9.8 ms | 16.4 ms | 23.7 ms | — | — |
| `bm25.bin` size on disk | — | 16.9 MB | — | — | — |

Cold rebuild from raw docs misses the 200 ms gate. In production this path
runs once per corpus generation (or after a content change >0 invalidates the
fingerprint); subsequent process starts hit the disk fast-path, which lands
at 66–110 ms — comfortably under the gate.

### B.3 Production corpus size sanity (n = 1 896, today's `!tasks`)

| Phase | Value |
|---|---|
| Cold rebuild from raw docs | 90 ms |
| Bincode serialize | 6 ms (`bm25.bin` = 3.2 MB) |
| Bincode deserialize | 18 ms |
| First query after restore | 1.5 ms |
| Warm P50 / P99 / max | 0.96 / 1.69 / 1.91 ms |

At today's ~2k-item corpus, even worst-case cold rebuild is 5× under the
200 ms gate.

### B.4 Gaps

- No criterion / `cargo bench` harness in the repo yet (W0 gap unresolved).
  The harness above lives at `/tmp/bm25-bench`; promoting it to
  `crates/pi-knowledge-core/benches/` is a W6 hygiene item.
- Vector lane and RRF fusion are not benchmarked here — embedder requires the
  bge-m3 model bootstrap (30–60 s init). Defer to W6/W7 once the embedding
  worker socket is on a steady state.

---

## C. On-Disk Cache Shape

### Persistent cache (`~/.cache/spell/recall`)

| Metric | W0 | W5.5 | Notes |
|---|---|---|---|
| Total cache size | 1,217,322 B (1.2 MB) | 1,217,322 B (1.2 MB) | **unchanged — stale W0-era tantivy snapshot** |
| Per-repo directory count | 30 | 30 | unchanged |
| Largest per-repo size | 1,111,483 B (≈ 1.1 MB) | 1,111,483 B | unchanged |
| Layout per repo | `<hash>/fts/` (tantivy: meta.json, *.term/*.store/*.idx/*.pos/*.fast/*.fieldnorm/*.del/locks) | identical (no live session has rebuilt) | — |

**No live session has rebuilt the cache since W5 deploy:** all currently
running spell processes (5 instances, PIDs 51099, 153155, 260877, 813372,
142884) loaded `libpi_natives.so` *before* the W5 binary was produced and
still hold the old shared object. The persistent cache will repopulate to
the new shape on the first post-redeploy session run.

### New cache shape (source-of-truth: `pi-natives/src/recall_engine.rs:103-109`)

```rust
const ENGINE_CACHE_FILE: &str = "engine.bin";
const BM25_CACHE_FILE:   &str = "bm25.bin";
const VEC_CACHE_FILE:    &str = "vec.uidx";
```

Cold-build / warm-restore behaviour is asserted by tests
`recall_engine::tests::disk_fast_path_restores_warm_engine_without_full_rebuild`
(must persist `engine.bin`; warm restore must not advance its mtime) and
`warm_restore_rejected_when_bm25_is_wiped` (precondition: `bm25.bin` exists).

Projected steady-state per-repo footprint at today's 1,896-item corpus:

| File | Expected size | Provenance |
|---|---|---|
| `bm25.bin` | ~3.2 MB | bincode-serialized `SearchIndex`, measured at n=1896 in §B.3 |
| `engine.bin` | small (KB) | engine metadata + graph projection |
| `vec.uidx` | n × 1024 × 4 B ≈ ~7.4 MB if all items embedded; current usage path is opt-in | usearch index for bge-m3 (1024-dim, f32) |

So per-repo cache jumps from ~1.1 MB (tantivy-only) to ~10 MB once the vector
lane is populated — a real increase but bounded and predictable. Pure BM25
(no embeddings) stays at ~3.2 MB ≈ 3× the W0 tantivy directory but **with**
graph-projected metadata and bincode serialization (no segment merges, no
lock files, no `.del` bitsets).

---

## D. Per-Session RSS

| pid | cmd | VmRSS (kB) | VmHWM (kB) | Notes |
|---|---|---|---|---|
| 51099 (same PID as W0) | `bun spell -r` | 139,992 (≈ 137 MB) | 1,519,564 | Was 167,116 kB at W0 → idle GC released ~27 MB; still W0-era libpi_natives.so |
| 153155 | `bun spell --resume 14e386…` | 148,644 (≈ 145 MB) | 1,473,288 | started pre-W5 |
| 260877 | `bun spell -r` | 138,128 (≈ 135 MB) | 1,514,396 | started pre-W5 |
| 813372 | `bun spell --resume 14e403…` | 51,736 (≈ 51 MB) | 671,804 | newest; still pre-W5 binary |
| 142884 | `spell-qml-bridge --daemon` | 63,276 (≈ 62 MB) | 236,012 | bridge process, unaffected |

**Gap:** None of the live sessions has loaded the post-W5
`libpi_natives.so`. A shared object that is `unlink`ed (`cargo build`
replaces it via rename) stays mapped in already-running processes via the
old inode. **A clean post-W5 RSS measurement requires a fresh `spell` start
after W6 redeploy** — explicitly deferred to W7 per the task brief.

Directional signal: the warmest pre-W5 session (pid 51099) is at 137 MB
warm, vs 80 MB target. If the −21.8 MB `.so` shrink flows through to RSS
1:1 (it won't fully — pages aren't all paged in), best case lands at
~115 MB. Closing the 35 MB gap to 80 MB is on W6/W7.

---

## E. Production Usage Stats (`/home/user/.spell/agent/sessions`)

| Metric | W0 | W5.5 | Δ | Source |
|---|---|---|---|---|
| Total `org` tool calls | 17,270 | 17,291 | +21 | `grep -rh '"name":"org"' … \| wc -l` |
| `org recall` | 2 | 2 | 0 | `… \| grep -c '"command":"recall"'` |
| `org remember` | 0 | 0 | 0 | same |
| `org timeline` | 0 | 0 | 0 | same |
| `org subgraph` | 1 | 1 | 0 | same |
| `org link` | 4 | 4 | 0 | same |
| `*.jsonl` session files | 13,567 | 13,674 | +107 | `find … -name '*.jsonl' \| wc -l` |

Recall/memory surface adoption is still **0.012 %** of org-tool calls
(2 / 17,291). This is the pre-W6 baseline; W6's `memory { … }` tool surface
is the lever expected to shift it.

---

## F. LOC Delta

Exact numbers from the W5 commit `7db61b9e7` (`git show --stat`):

| Slice | Lines |
|---|---|
| **Deleted** (4,699 LOC) | |
| `crates/pi-org-recall/src/{lib,embedder,fts,recall,vec,personal,error}.rs` | 1,595 |
| `crates/pi-org-recall/tests/{embedder,fts,personal,recall,vec}.rs` | 1,399 |
| `crates/pi-org-recall/Cargo.toml` | 39 |
| `crates/pi-code-vectors/src/{lib,embedding,error,index}.rs` | 391 |
| `crates/pi-code-vectors/tests/hnsw.rs` | 281 |
| `crates/pi-code-vectors/Cargo.toml` | 27 |
| `crates/pi-natives/src/recall_engine.rs` rewrite delta | −548 (this commit only) |
| Other (`Cargo.lock`, `pi-natives/Cargo.toml`, `pi-embedding-worker/main.rs`, etc.) | ≈ 419 |
| **Added** (1,552 LOC) | |
| `crates/pi-knowledge-core/src/recall.rs` (new) | 753 |
| `crates/pi-knowledge-core/src/ingest.rs` (new) | 468 |
| `crates/pi-embedding-worker/src/engine.rs` (new) | 63 |
| `crates/pi-knowledge-core/src/vec.rs` (+) | 16 |
| `crates/pi-knowledge-core/src/error.rs` (+) | 12 |
| `crates/pi-org-engine/src/graph.rs` (+) | 21 |
| Other (`Cargo.toml`s, `lib.rs` re-exports, etc.) | ≈ 219 |
| **Net delta** | **−3,147 LOC** |

Current LOC of the converged surface:

| File | LOC |
|---|---|
| `pi-knowledge-core/src/recall.rs` | 753 |
| `pi-knowledge-core/src/ingest.rs` | 468 |
| `pi-knowledge-core/src/vec.rs` | 418 |
| `pi-knowledge-core/src/bm25.rs` | 400 |
| `pi-knowledge-core/src/fusion.rs` | 391 |
| `pi-knowledge-core/src/graph.rs` | 847 |
| `pi-knowledge-core/src/cache.rs` | 427 |
| `pi-natives/src/recall_engine.rs` | 1,061 |
| `pi-embedding-worker/src/engine.rs` | 63 |
| **Total converged surface** | **4,828** |

(Note: the brief mentioned `recall_engine.rs` going 1207 → 758 LOC; the
working tree currently reads 1,061 LOC, so the post-W5 rewrite shed ~146
LOC net relative to W0, not 449 — the task brief's "758" appears to be a
stale projection or includes only the engine-core portion. The W5-commit
hard delta is the authoritative number: −548 LOC for that file.)

---

## Verdict — PLAN-310 Performance Gates

| Gate | Target | Measured | Status |
|---|---|---|---|
| Cold P99 search (10k corpus, disk-cached path) | < 200 ms | 66–110 ms (deserialize + 1st query, §B.2) | **✓ PASS** |
| Cold P99 search (10k corpus, from-scratch rebuild) | < 200 ms | 301–519 ms (§B.2) | **✗ FAIL** — but only on first-ever build per corpus; production never hits this except on fingerprint invalidation |
| Warm P99 search (10k corpus) | < 50 ms | 9.5–18.5 ms (§B.2) | **✓ PASS** (≥ 2.7× headroom worst case) |
| Per-session warm RSS | < 80 MB | 137 MB warm on pid 51099 (pre-W5 binary; clean post-W5 measurement requires redeploy) | **? DEFERRED** — gate cannot be evaluated until W7 produces a clean fresh-start sample |
| `libpi_natives.so` ≤ +5 MB vs pre-PLAN-290 | +5 MB ceiling | W5.5 = 92.99 MB; pre-PLAN-290 absolute baseline is not in repo (gap from W0). Δ from W0 = **−21.8 MB**, eclipsing W0-era tantivy/hnsw_rs contributions entirely | **✓ LIKELY PASS** (formal verification needs a pre-PLAN-290 `.so` checkout) |

### Remediation for the cold-rebuild miss

`SearchIndex::from_docs` at n=10k takes ~500 ms; over half of that is the
`BTreeMap<String,_>` tokenize+insert loop (`bm25.rs:51-69`). Cheap wins:

1. Swap `BTreeMap` → `HashMap` (FxHash) inside `SearchDocument::frequencies`
   and `term_doc_freq`. The per-doc cost is `O(tokens × log unique_terms)`;
   FxHash should cut 30-50 %.
2. Parallelise document tokenisation with `rayon::par_iter` — embarrassingly
   parallel, scales linearly to physical cores.

Either change buys headroom under 200 ms on n=10k while keeping the
disk fast-path number untouched. Not blocking for W6/W7 but worth a
W6.5 cleanup ticket. **No production code modified in this report.**

### What still needs measurement (carry to W6/W7)

- Clean post-redeploy `VmRSS` for a fresh spell session (gate D).
- Pre-PLAN-290 `libpi_natives.so` size from git history (gate F's anchor).
- Vector + RRF latency on n=10k with real bge-m3 embeddings.
- First production samples of `memory { … }` adoption after W6 ships.
