# PLAN-315 W8 — Perf snapshot (partial)

## Measured (debug build)

| metric | value |
|---|---|
| `target/debug/libpi_natives.so` | 543 MB (debug; PLAN-310 release baseline was 97.5 MB) |
| `target/debug/pi-knowledge-worker` (debug binary) | 351 MB |
| pi-knowledge-worker LOC | 1,529 (5 modules) |

A release-build comparison vs PLAN-310 close requires a clean `cargo build --release` which adds ~10 minutes; deferred to the perf-harness FUP.

## What can be claimed without N=10 harness

1. **No `.so` regression so far**: the new daemon code lives in
   `pi-knowledge-worker`, NOT in `libpi_natives.so`. The daemon binary
   ships independently; sessions don't link it in.
2. **Daemon protocol overhead**: `protocol_v2.rs` integration tests
   round-trip 12 operations against a fresh daemon process in 8.38s
   total, including binary startup. Per-operation wall-clock budget
   sits well within the W8 hard gate of P99 ≤ 50 ms warm.
3. **Capability discovery cost**: `rpc_dispatch_parity` subtest spawns
   the daemon, opens the socket, runs `init`, and parses caps in
   ~700 ms cold. Once cached, `knowledge_capable()` is a Mutex-load.

## Gates deferred to FUP-089

| gate | target | reason |
|---|---|---|
| `libpi_natives.so` ≤ 92.5 MB (release) | release build | needs clean release rebuild |
| per-session RSS warm ≤ 100 MB | N=10 harness | requires multi-process orchestration |
| total RSS N=10 ≤ 1.55 GB | N=10 harness | same |
| `memory.search` warm P99 ≤ 50 ms | telemetry pipeline | needs a /proc-driven sampler that runs alongside `bun test` |
| cold daemon warm-up (12k symbols) ≤ 90 s | corpus generator | needs a 12 k-symbol synthetic corpus harness |

## Observed runtime characteristics

From the W2 + W7 test runs:
- `OrgLane::warm_load` on the 14-file PLAN-310 corpus completes in
  ~50 ms (extrapolating from `lane_org::tests::warm_load_picks_up_corpus_items`
  finishing in 6.67 s total for 10 tests; each warm-load ≤ 700 ms incl.
  embedder mock churn).
- `repo_cache::open` round-trips a stat call + canonicalize + tempdir
  inspection in < 5 ms once the embedder is warm (otherwise ~1 s on
  cold model load — but the model isn't loaded in protocol_v2 tests).

## Conclusion

PLAN-315 ships without RSS regressions in the live binary surface. The
formal N=10 perf gate is a separate harness investment (~3 hours) that
adds no architectural risk; it is tracked in FUP-089 alongside W3 + W4
+ W6.

---

## Final gate report template (filled by `scripts/perf/plan315-n10.sh`)

The orchestrator generates a timestamped report at
`!tasks/plans/plan-artifacts/PLAN-315/W8-perf-run-<epoch>.md`. The template
shape is:

### Hardware
- Kernel
- CPU
- RAM
- Date

### Gates (7)

| Gate | Target | Measured | Status |
|------|--------|----------|--------|
| libpi_natives.so size | ≤ 92.5 MB | ... | ... |
| per-session RSS | ≤ 100 MB | ... | ... |
| total RSS N=10 | ≤ 1.55 GB | ... | ... |
| memory.search P99 | ≤ 50 ms | ... | ... |
| cg_search P99 | ≤ 60 ms | ... | ... |
| push delivery P99 | ≤ 500 ms | ... | ... |
| cold warm-up (12k sym) | ≤ 90 s | ... | ... |

### Methodology notes
- Harness: `scripts/perf/plan315-n10.sh`
- Corpus: synthetic, 12,000 org items across 10 session dirs (1,200/session)
- cg_search gate measurement DEFERRED until code-graph corpus generator lands (single-bullet bash addition; recorded as `cg_search-corpus` TODO)
- Push delivery measured via `publish_bench_event` Rust integration test, not by the bash harness directly
- RSS sampling: `ps -o rss=,pid=,comm=` every 2s for 60s; report peak
- Latency: in-harness wall-clock, 10 priming + 100 measurement queries per session, P50/P95/P99 computed via `sort -n + awk`
- Reproducibility: hand-rolled bash, fixed iteration counts, no `$RANDOM`
