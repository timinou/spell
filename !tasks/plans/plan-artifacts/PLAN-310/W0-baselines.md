# PLAN-310 Wave 0 Baselines

Measured on 2026-05-21 against commit at `/home/user/code/ora/spell`.
These numbers are the W5.5 performance-gate comparison anchor.

---

## A. Binary Size

| Metric | Value | Command |
|---|---|---|
| `libpi_natives.so` (release) | 120,342,000 bytes (114.8 MB) | `stat -c %s target/release/libpi_natives.so` |
| `libpi_natives.so` stripped | 120,342,000 bytes (no change) | `strip -o /tmp/… && stat -c %s …` |
| Tantivy rlib total | 148,249,278 bytes (141.4 MB) | `du -cb target/release/deps/libtantivy*.rlib` |
| hnsw_rs rlib | 43,511,702 bytes (41.5 MB) | `du -cb target/release/deps/libhnsw_rs*.rlib` |
| fastembed rlib | 46,105,822 bytes (44.0 MB) | `du -cb target/release/deps/libfastembed*.rlib` |
| Cargo tree depth | 1,820 unique packages | `cargo tree -p pi-natives --format '{p}' \| wc -l` |
| Tantivy transitive subcrate count | 16 | `cargo tree -p pi-natives \| grep -c tantivy` |

**Note:** The release `.so` was already stripped (`file` reports `stripped`), so the
`strip` pass produced identical output.

---

## B. BM25 Latency (Cold + Warm)

**Gap:** `cargo test -p pi-org-recall --release` timed out after 600 s during
tantivy/dependency compilation on both attempts. No release test binary was
produced.

**Proxy measurement:** Debug test binary (`target/debug/deps/pi_org_recall-*`)
already existed; timings below are from debug builds and therefore over-estimate
release latency by a typical 3–10× factor.

Tests are from `crates/pi-org-recall/src/fts.rs`. Wall-clock captured by the
Rust test harness (`--nocapture --test-threads=1`).

| Test | Debug wall-clock |
|---|---|
| `cache_base_falls_back_to_home_when_xdg_unset` | 0.00 s |
| `repo_hash_is_stable_across_calls` | 0.02 s |
| `delete_doc_by_id` | 0.31 s |
| `multi_term_phrase_query` | 0.38 s |
| `scope_filter_excludes_other_kinds` | 0.38 s |
| `open_and_index_returns_results` | 0.52 s |
| `empty_query_returns_empty` | 0.63 s |
| `reindex_replaces_existing_doc` | 0.68 s |
| `stemming_matches_run_running_runs` | 0.70 s |
| **Total FTS suite (9 tests)** | **~3.62 s** |
| **Full suite incl. recall tests (13 tests)** | **4.61–5.68 s** |

**Gap note:** No dedicated `cargo bench` target exists in `pi-org-recall` (no
`benches/` directory). A proper cold-start benchmark that measures
open-index → first-query latency separately from warm-query latency is
not yet present.

---

## C. On-Disk Cache Shape

| Metric | Value | Command |
|---|---|---|
| Total cache size | 1,217,322 bytes (1.2 MB) | `du -sb ~/.cache/spell/recall` |
| Per-repo directory count | 30 | `ls ~/.cache/spell/recall \| wc -l` |
| Largest cache directory | `/home/user/.cache/spell/recall/e92bedbc832d` | `du -sb …/*/fts \| sort -rn \| head -1` |
| Largest `fts/` size | 1,111,483 bytes | same |

Contents of largest `fts/` (tantivy index, not the final converged format):

| File | Size | Role |
|---|---|---|
| `meta.json` | 2,637 bytes | Segment manifest + settings |
| `.managed.json` | 1,748 bytes | File inventory |
| `*.term` × 6 | ~55–72 kB each | Term dictionaries |
| `*.store` × 6 | ~69–103 kB each | Doc store (lz4) |
| `*.idx` × 6 | ~14–22 kB each | Postings |
| `*.pos` × 6 | ~6.7–10 kB each | Positional index |
| `*.fieldnorm` × 6 | ~4.6–7.1 kB each | Field norms |
| `*.fast` × 6 | 145–146 bytes each | Fast fields |
| `*.del` × 6 | 217–274 bytes each | Delete bitsets |
| `.tantivy-meta.lock` | 0 bytes | Lock file |
| `.tantivy-writer.lock` | 0 bytes | Lock file |

**Gap note:** No `engine.bin` or `vec.bin` files exist yet; the current cache
is pure tantivy. These will appear when the converged HNSW + BM25 store lands
in W2–W4.

---

## D. Per-Session RSS Impact

| Metric | Value | Source |
|---|---|---|
| Spell PID sampled | 51099 | `pgrep -f spell \| head -1` |
| VmRSS (current resident) | 167,116 kB (~163 MB) | `/proc/51099/status` |
| VmHWM (peak resident) | 1,519,564 kB (~1.45 GB) | `/proc/51099/status` |

**Note:** The process was an active interactive session at measurement time.
The 1.45 GB peak reflects transient allocation (likely model loading). The
163 MB warm figure is the relevant baseline for W5.5 comparison.

---

## E. Production Usage Stats (from this machine’s session logs)

| Metric | Count | Command |
|---|---|---|
| Total `org` tool calls | 17,270 | `grep -rh '"name":"org"' …sessions \| wc -l` |
| `recall` | 2 | `… \| grep -c '"command":"recall"'` |
| `remember` | 0 | `… \| grep -c '"command":"remember"'` |
| `timeline` | 0 | `… \| grep -c '"command":"timeline"'` |
| `subgraph` | 1 | `… \| grep -c '"command":"subgraph"'` |
| `link` | 4 | `… \| grep -c '"command":"link"'` |
| Total session JSONL files | 13,567 | `find …sessions -name '*.jsonl' \| wc -l` |

**Observation:** Recall/memory surface usage is extremely low today
(7 calls total out of 17,270 org invocations). The W6 `memory { … }` tool
surface is expected to shift this balance.

---

## F. Corpus Stats

| Metric | Value | Command |
|---|---|---|
| Org item files | 1,896 | `find '!tasks' -name '*.org' \| wc -l` |
| Total org body bytes | 13,152,507 (~12.5 MB) | `find '!tasks' -name '*.org' -printf '%s\n' \| awk '{s+=$1} END {print s}'` |
| Files with `:RELATIONS:` drawer | 4 | `grep -rl ':RELATIONS:' '!tasks' \| wc -l` |
| Files with `:KIND:` drawer | 3 | `grep -rl ':KIND:' '!tasks' \| wc -l` |

---

## Summary Table

| Category | Baseline Value | W5.5 Target |
|---|---|---|
| `libpi_natives.so` release size | 114.8 MB | ≤ +5 MB vs pre-PLAN-290 baseline |
| Tantivy rlib weight | 141.4 MB | 0 MB (deleted) |
| hnsw_rs rlib weight | 41.5 MB | 0 MB (replaced by usearch) |
| fastembed rlib weight | 44.0 MB | TBD (bge-m3 via ort) |
| Cargo tree depth | 1,820 packages | ↓ (exact target TBD) |
| BM25 cold P99 search (debug proxy) | ~700 ms worst single-test debug | < 200 ms (release, 10k corpus) |
| BM25 warm P99 search | ~300–700 ms debug | < 50 ms (release, 10k corpus) |
| Per-session warm RSS | 163 MB | < 80 MB |
| On-disk cache per repo | ~1.1 MB (tantivy) | TBD (converged format) |
| Org corpus files | 1,896 | 10,000 (synthetic gate corpus) |
| Org corpus bytes | 12.5 MB | ~65 MB (estimated at 10k) |

---

## Targets for W5.5 (carried forward from PLAN-310)

1. **Cold P99 search < 200 ms** on a 10k-item corpus.  
   *Baseline proxy:* 700 ms debug single-test wall-clock; release expected ~70–230 ms.

2. **Warm P99 search < 50 ms** on a 10k-item corpus.  
   *Baseline proxy:* 300–700 ms debug; release expected ~30–70 ms.

3. **Per-session resident overhead < 80 MB** warm.  
   *Baseline:* 163 MB current warm RSS. The delta is assumed to come from
dropping tantivy + hnsw_rs and moving to a leaner unified runtime.

4. **`libpi_natives.so` contribution ≤ +5 MB** vs pre-PLAN-290 baseline.  
   *Baseline:* 114.8 MB today. Need to establish pre-PLAN-290 reference in W1.

---

## Documented Gaps

| Gap | Reason | Unblocks |
|---|---|---|
| Release BM25 timing | `cargo test -p pi-org-recall --release` times out after 600 s during tantivy dep compilation | W1: add `cargo bench` target or criterion benchmark |
| Cold-vs-warm separation | Existing tests create + drop index per test; no separate cold-open vs warm-query harness | W1: benchmark scaffolding in `tests/fixtures/` |
| engine.bin / vec.bin | Not yet created; current cache is pure tantivy | W3–W4: converged storage format |
| Pre-PLAN-290 `.so` baseline | Not measured in W0; need historical artifact or git checkout | W1: establish reference size |
| Peak RSS vs warm RSS | VmHWM (1.45 GB) includes transient model loads; need stable warm measurement protocol | W5: dedicated RSS sampling harness |
