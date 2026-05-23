# W8 — N=10 perf harness implementation plan

## 1. Existing perf/bench infrastructure (file:line refs)

### Criterion

The workspace has exactly **one** criterion bench today:

- `crates/pi-natives/benches/codepath_bench.rs` — 5 benchmarks for CodePath hot paths:
  - `grep_todo_spell_repo` — walk ~3K .rs files grepping "TODO"
  - `parse_codepath_x1000` — parse 20 canonical paths × 50×
  - `get_500line_file` — resolve `§line[10..20]` on 500-line temp file
  - `resolve_50_symbols` — resolve 50 symbols (fn + struct) in a temp file
  - `traverse_edges` — stubbed (no graph fixture available)
- Config: `crates/pi-natives/Cargo.toml:139` (`criterion = { version = "0.5", features = ["html_reports"] }`), bench lines 144-145 (`[[bench]] name = "codepath_bench"`, `harness = false`)
- Run: `cargo bench -p pi-natives --bench codepath_bench`

These measure **CodePath resolver speed**, not daemon query latency or RSS. No overlap with W8 gates.

### Bench in other crates

- `crates/brush-builtins-vendored/Cargo.toml:22` → `autobenches = false`
- `crates/brush-core-vendored/Cargo.toml:22` → `autobenches = false`
- `crates/pi-knowledge-worker/Cargo.toml` → **no bench section**, no `criterion` dep, no `[[bench]]` entry

**Conclusion**: zero existing bench infrastructure for the daemon or session-level perf. W8 harness is greenfield.

---

## 2. Daemon `stats` command surface — what's exposed today, what's missing

### Current shape

Defined at `crates/pi-knowledge-worker/src/main.rs:81-86`, handler at `repo_cache.rs:205-241`.

**Daemon-wide** (`repo_handle: None`):
```json
{
  "daemon_rss_bytes": 12345678,
  "repos": [/* per-repo objects */],
  "max_warm_repos": 8
}
```

**Per-repo** (`repo_handle: "fnv:..."`):
```json
{
  "repo_handle": "fnv:XXXXXXXXXXXXXXXX",
  "repo_root": "/path/to/repo",
  "lanes": ["org_memory", "code_graph"],
  "include_personal": false,
  "last_used_ms_ago": 42,
  "opened_at_ms": 1716000000000
}
```

`rss_bytes()` implementation at `repo_cache.rs:244-259` — reads `/proc/self/statm` field 1 (resident pages) × `sysconf(_SC_PAGESIZE)`, returns 0 on non-Linux.

### What's missing

| Missing field | Needed for gate | Suggestion |
|---|---|---|
| Per-session/connection RSS | per-session RSS ≤ 100 MB | Not possible from inside daemon. Must use `ps` external sampling. |
| Command latency (per-query) | `memory.search` P99 ≤ 50 ms, `cg_search` P99 ≤ 60 ms | Not exposed. Add minimal in-harness timestamping (see §4). |
| Push delivery latency | push ≤ 500 ms | Not exposed at socket level. Need `bench_event` instrumentation. |
| Cold daemon start time | warm-up ≤ 90 s | Daemon doesn't report its own boot time. Need external clock at spawn. |
| Uptime / request count | diagnostic context | Would be nice but not gate-critical. Defer. |

**Conclusion**: stats command surfaces daemon RSS (self-only) and slot metadata. Everything else must be measured externally. Do NOT extend the protocol — the delta is too small to justify wire break vs. external sampling.

---

## 3. Multi-process orchestration approach

### Chosen pick: Bash script (`scripts/perf/plan315-n10.sh`)

**Rationale** (1 sentence): Bash handles process spawning, PID tracking, pgrep sampling, and `time` measurement natively with zero build overhead — no Rust compile cycle, no bun dependency for the orchestrator itself.

### Alternatives considered

| Approach | Rejected because |
|---|---|
| Rust test binary (`cargo test --test perf_n10`) | Adds compile time, can't gracefully handle multi-process lifecycle, harder to `pgrep` child PIDs from inside test. |
| Bun script (`bun run scripts/perf/n10.ts`) | Works but adds TypeScript dependency for a pure-process-orchestration task; bash is more transparent for sampling. |

### Process tree

```
perf harness (bash PID=$$)
  ├── daemon (pi-knowledge-worker --socket /tmp/perf-XXXX/embed.sock)
  │     └── warm-load threads (per lane)
  ├── session-1  (client binary via socket)
  │     └── synthetic corpus at /tmp/perf-XXXX/sessions/1/
  ├── session-2  ...
  ├── ...
  ├── session-10
  └── sampler (subshell loop: ps every 2s for 60s)
```

### Synthetic corpus per session

- **Location**: `/tmp/perf-XXXX/sessions/{1..10}/<repo>.spell-test/`
- **Size**: ~2 MB per session, 5,000 symbols each
- **Symbol count target**: 12,000 org items total across all sessions (matching the "12k symbols" cold start gate) — can be 1,200 `.org` files × 10 symbols each per session, or fewer larger files
- **Generation approach**: Hand-rolled bash script generates `concept-0001.org` through `concept-5000.org` with one `* CON-XXXX` heading + `:PROPERTIES:` drawer + `:CUSTOM_ID:` per file. This avoids git dependency while exercising the full warm-load path.
- **Code-graph lane**: Generate `.rs` files with 500 symbols each (fn + struct) to exercise `cg_search` / `cg_definition` / `cg_references` / `cg_callers` queries.

---

## 4. Sampling strategy

### RSS: `ps` every 2s for 60s

```
# Measurement command
ps -o rss=,pid=,comm= -p $(pgrep -f 'pi-knowledge-worker|pi-natives') 2>/dev/null
```

- **Per-session RSS**: Each session is a client process that opens a socket to the daemon. The daemon process is shared — so "per-session" RSS approximates as `(total_daemon_rss) / N` + client process RSS. Report both aggregate and per-client.
- **Total RSS N=10**: Sum of all process RSS values (daemon + 10 clients) sampled at peak.
- **Sampling window**: 2s interval for 60s = 30 samples per run.
- **What lands in report**: per-session peak, per-session mean, total RSS peak, total RSS mean.

### Latency: in-harness timestamping (NOT daemon log scrape)

For `memory.search` and `cg_search`:

```bash
# In a tight loop inside the bash harness (or a small Rust helper):
start=$(date +%s%N)
echo '{"command":"search","repo_handle":"fnv:...","query":{...}}' > /tmp/perf-XXXX/session-N/in
# (response read from socket stdout)
end=$(date +%s%N)
echo $(( (end - start) / 1000000 )) >> /tmp/perf-XXXX/session-N/search-ms.log
```

- **Loop count**: 100 warm queries per session.
- **P50/P95/P99**: computed from `search-ms.log` using `sort -n | awk`.
- **Warm condition**: Execute 10 priming queries first, discard their timings, then record the 100 measurement queries.

### Push delivery: clock-stamp at daemon emit + at client receive

- **Instrumentation**: Add a minimal `Event::BenchPayload { emitted_at: u64, payload_id: u32 }` variant to the subscribe Event enum at `subscribe.rs:94-125`. The daemon stamps `Instant::now().as_millis()` at emit; the client records `Instant::now().as_millis()` at receive in the callback. Difference = push delivery latency.
- **Delta**: ~10 LOC in `subscribe.rs`, zero protocol break (new variant is additive, existing code ignores unknown events).
- **Test**: One-shot: daemon emits a BenchPayload, client records the delta. Repeat 50×.
- **No coupling to real workload**: BenchPayload is synthetic — no warm-load, no eviction needed.

### Cold warm-up: time-to-first-search after process spawn

```bash
daemon_start=$(date +%s%N)
./pi-knowledge-worker --socket /tmp/perf-XXXX/embed.sock &
# Wait for socket
while [ ! -S /tmp/perf-XXXX/embed.sock ]; do sleep 0.05; done
# Send open (triggers warm-load for org_memory + code_graph)
echo '{"command":"open","repo_root":"/tmp/perf-XXXX/sessions/1","lanes":["org_memory","code_graph"]}' \
  > /tmp/perf-XXXX/socket
# Read response → receive WarmCompleted event → record time
warmup_end=$(date +%s%N)
echo "cold_warmup_ms=$(( (warmup_end - daemon_start) / 1000000 ))" >> report
```

- **12k symbol annotation**: Generate org files so that `warm_load` processes ~12,000 `* CON-*` headings total.

### Where each measurement lands

| Measurement | Section in report |
|---|---|
| libpi_natives.so size | `### binary size` |
| Per-session RSS | `### per-session RSS` |
| Total RSS N=10 | `### total RSS (N=10)` |
| memory.search P50/P95/P99 | `### memory.search latency` |
| cg_search P50/P95/P99 | `### cg_search latency` |
| Push delivery P50/P95/P99 | `### push event delivery` |
| Cold daemon warm-up | `### daemon warm-up` |

---

## 5. Hard-gate enforcement

### Gate table

| # | Gate | Measurement | Measurement method | Tolerance margin | Report PASS if |
|---|---|---|---|---|---|
| 1 | `libpi_natives.so` ≤ 92.5 MB (release) | `ls -lh target/release/libpi_natives.so` or `.node` | `du -b` on release artifact | 2.5 MB slack | ≤ 90.0 MB |
| 2 | per-session RSS ≤ 100 MB | Peak RSS from `ps` sampling | `ps -o rss=,pid= -p $PID` every 2s, take max | 10 MB slack | ≤ 90 MB |
| 3 | total RSS N=10 ≤ 1.55 GB | Sum of all daemon+client RSS | Sum of pgrep output, peak sample | 50 MB slack | ≤ 1.50 GB |
| 4 | `memory.search` warm P99 ≤ 50 ms | In-harness wall-clock timestamping | 100 queries × 10 sessions, sort + awk percentile | 5 ms slack | ≤ 45 ms |
| 5 | `cg_search` warm P99 ≤ 60 ms | Same as above for `cg_search` cmd | 100 queries × 10 sessions | 5 ms slack | ≤ 55 ms |
| 6 | Push event delivery ≤ 500 ms | BenchPayload emit→receive delta | 50 iterations × 10 sessions | 50 ms slack | ≤ 450 ms |
| 7 | Cold daemon warm-up (12k symbols) ≤ 90 s | Wall-clock from spawn to first search response | Single cold start with full corpus | 10 s slack | ≤ 80 s |

### Pass/fail rendering

```markdown
| Gate | Target | Measured | Status |
|------|--------|----------|--------|
| libpi_natives.so size | ≤ 92.5 MB | 84.2 MB | ✅ PASS |
| per-session RSS | ≤ 100 MB | 72.3 MB | ✅ PASS |
| total RSS N=10 | ≤ 1.55 GB | 1.02 GB | ✅ PASS |
| memory.search P99 | ≤ 50 ms | 38 ms | ✅ PASS |
| cg_search P99 | ≤ 60 ms | 42 ms | ✅ PASS |
| push delivery P99 | ≤ 500 ms | 120 ms | ✅ PASS |
| cold warm-up (12k sym) | ≤ 90 s | 45 s | ✅ PASS |
```

FAIL rows get `❌ FAIL` in Status and a bold red-adjacent indicator.

---

## 6. File-by-file implementation outline

### 6a. `scripts/perf/plan315-n10.sh` (new, ~180 LOC)

**Purpose**: Top-level orchestrator — generates corpus, spawns daemon + 10 sessions, samples RSS, runs queries, computes percentiles, produces report.

**Structure**:
```
plan315-n10.sh
├── 1. Setup (trap cleanup, mkdir /tmp/perf-$$/, resolve binaries)
├── 2. Generate synthetic corpus (12k symbols in 10 session dirs)
├── 3. Build release binaries if not present
├── 4. Measure libpi_natives.so size
├── 5. Spawn daemon + wait for socket
├── 6. Measure cold warm-up (open → WarmCompleted)
├── 7. Spawn 10 session processes (each: open → warm queries → push test → close)
├── 8. Background sampler (ps every 2s for 60s → /tmp/perf-$$/rss-samples.log)
├── 9. Compute P50/P95/P99 from latency logs
├── 10. Render gate PASS/FAIL table
└── 11. Cleanup (kill daemon, remove temp dir)
```

**Dependencies**: `bash` ≥ 4, `pgrep`, `ps` (procps-ng), `date` with `+%s%N`, `sort`, `awk`, `du`, `ls`, `timeout`, `nc` or direct socket write (via `/dev/tcp` or `socat`). Target: any Linux with these standard tools.

**Edge Cases**:
- `pgrep -f` may match parent script; filter by PID not name where needed.
- Daemon crash: expect `wait` on daemon PID to detect premature exit; abort with diagnostic.
- Socket not ready: use busy-poll (50ms sleep, 30s timeout) matching existing pattern at `subscribe_client_e2e.rs:68-73`.
- Release binary not yet built: suggest `cargo build --release -p pi-knowledge-worker` and measure `.so` from existing release build.
- Partial gate failure: still render all gates, do not halt on first failure.

### 6b. `crates/pi-knowledge-worker/benches/bench_event.rs` (new, ~60 LOC)

**Purpose**: Criterion bench for push-delivery latency (or stand-alone if criterion dep not desired in pi-knowledge-worker).

**Design**:
- Spawn an in-process EventRegistry + LaneEvents
- Subscribe a channel
- Emit N `Event::BenchPayload` events, timestamp before and after each emit
- Measure round-trip from emit → receive on channel
- Compute P50/P95/P99

**Alternative**: If criterion dep is undesirable (currently pi-knowledge-worker has none), use a standalone Rust bin: `crates/pi-knowledge-worker/src/bin/bench_push.rs` with hand-rolled timing loop.

**Recommended**: Add `Event::BenchPayload` variant to `subscribe.rs:94-125` (~10 LOC in existing enum), then write a simple `#[test]` that exercises it (no criterion needed).

### 6c. `!tasks/plans/plan-artifacts/PLAN-315/W8-perf.md` (update existing, ~80 LOC delta)

**Purpose**: Final report template. Populated by the harness script. The existing `W8-perf.md` at that path already has partial measurements (debug build sizes); update it with release-build numbers and the full gate table.

**Existing content**: Lines 1-41 show debug sizes and deferred-gate rationale. Append the gate comparison table + measured percentiles after conclusion.

### 6d. `crates/pi-knowledge-worker/src/subscribe.rs` (edit, +10 LOC)

**Purpose**: Add `Event::BenchPayload` variant for push latency measurement without coupling to real workload.

```
pub enum Event {
    // ... existing variants unchanged ...
    /// Synthetic benchmark payload; emitted_at in epoch ms.
    BenchPayload {
        emitted_at: u64,
        payload_id: u32,
    },
}
```

No protocol break — new variant, unknown to pre-existing subscribers (they'll see `{"event":"bench_payload",...}`). Not emitted during normal operation.

---

## 7. Subagent dispatch breakdown

### Phase 1: Foundation (parallel-safe)

| Task | Description | Est. LOC | Deps |
|---|---|---|---|
| **T1** | Add `Event::BenchPayload` variant to `subscribe.rs` | +10 LOC | None |
| **T2** | Write corpus generator section in `plan315-n10.sh` | +60 LOC | None — just mkdir + heredoc loops |
| **T3** | Write static report template update for `W8-perf.md` | +20 LOC | None — markdown only |

### Phase 2: Harness (depends on T2)

| Task | Description | Est. LOC | Deps |
|---|---|---|---|
| **T4** | Write orchestrator core in `plan315-n10.sh` (spawn, sample, compute, render) | +120 LOC | T2 (corpus dirs exist) |

### Phase 3: Validate

| Task | Description | Deps |
|---|---|---|
| **T5** | Run harness, confirm all 7 gates report, fix any failures | T4 |

---

## 8. Risk / open questions

### Synthetic corpus generation: hand-rolled vs sample-real-repos

**Decision**: Hand-rolled bash loops (1200 `org` files × 10 headings each). Rationale:
- Real repos introduce setup cost (git clone, noise from unanticipated file sizes)
- 12k org items is simple to generate and exercises the same warm-load code path
- Code-graph lane needs `.rs` files — generate 12 files × 400 symbols each (valid Rust fn/struct defs)

### CI vs local-only

**Decision**: Local-only for now. RSS gates depend on the host machine's memory pressure and hardware profile — CI runners have unpredictable baseline memory usage and no swap guarantee. The script documents hardware specs (CPU, RAM, kernel) at the top of the report.

**Risk**: If CI is needed later, would require a dedicated runner with:
- 16 GB+ RAM
- Swap off for reproducible RSS
- CPU pinning or at least warm cache

### Reproducibility

- Pin RNG seeds: `RANDOM=42` for bash `$RANDOM` if used; otherwise fixed iteration patterns.
- Record `uname -a`, `/proc/cpuinfo | grep 'model name' | head -1`, `free -g` in report header.
- All temp files under `/tmp/perf-<script-pid>/` — no cross-run interference.
- Run 3× back-to-back; report min/mean/max for each gate.

### Push delivery gate feasibility

**Risk**: Push delivery ≤ 500 ms uses a new `BenchPayload` event variant. If the daemon's `publish()` call + socket write + client socket read introduces measurable overhead (e.g. channel blocking, context switching), the 500 ms target could fail on debug builds but pass on release. Recommend testing with release build only for this gate.

### Cold warm-up vs incremental

**Risk**: The "12k symbols ≤ 90 s" gate is a single cold-start measurement. Real-world usage is incremental warm-load. If cold fails but incremental passes, the gate is still meaningful but documenting this distinction is important for the report.

### Release build cost

Building `pi-knowledge-worker --release` takes ~10 minutes (from existing `W8-perf.md` estimate). Build once, measure N=10 sessions against the same binary. Include a `--build` flag that does this automatically, or document manual build step.

### ps sampling overhead

`ps -o rss=,pid=,comm=` every 2s for 60s = 30 invocations. Each `ps` is ~1-2ms on modern kernels. Total overhead < 100ms — negligible relative to the 60s window.
