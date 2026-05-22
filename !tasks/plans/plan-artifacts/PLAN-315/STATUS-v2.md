# PLAN-315 — execution status (branch `plan-315-complete`)

## Final session delivery (20 commits ahead of `main`)

```
155f8553e  fix(scripts,docs): W8.5 gap-fix — daemon JSON shape + sustained python + gate honesty
8c00074aa  fix(coding-agent): W6.5 gap-fix — preserve this binding + guard since-tab race
7668078ba  docs(plan-315): W8.5 review wave — findings
3b70b2c43  docs(plan-315): W6.5 review wave — findings
449e38dd2  feat(coding-agent): W6T3 — Alt+M binding + selector wiring
6be0a88ba  feat(coding-agent): W6T2 — search/graph/recent/since tab implementations
1197e32f3  feat(pi-knowledge-worker,scripts): W8 — N=10 perf harness + BenchPayload event
5193cebc0  feat(coding-agent): W6T1 — memory browser panel core + actions wrapper
0491af6f0  docs(plan-315): W5.5 review wave — W5 findings
7871653b9  docs(plan-315): W8 research — N=10 perf harness implementation plan
63b938685  docs(plan-315): move W6-research.md into !tasks/ tree
7dd6ee760  feat(pi-natives): W5 — explicit PI_KNOWLEDGE_WORKER mode, fail-loud RPC
c6b084957  docs(plan-315): W6 research — TUI /memory browser implementation plan
fd28f56ec  docs(plan-315): W9 close on plan-315-complete branch
89c6400cc  fix(tests): T10.1 — scope:[episode]
7e35f85cd  fix(pi-natives,tests): T10.4 + T10.5 memory-loop fixes
3e8fa03c5  fix(coding-agent): T10.6 — since-by-birthtime classification
c583bb3da  feat(pi-knowledge-worker): W3 — code-graph lane in daemon
431ee3b88  feat(pi-natives): W4 client — KnowledgeSubscription handle
9cb1d9080  feat(pi-knowledge-worker): W4 daemon — push-subscribe protocol
```

## Plan state at branch tip

```
✓ Pre-flight  BUG-390 flake fix
✓ W0          Protocol design + ingest audit
✓ W1          Daemon rename + protocol v2 + open/close/stats   FEAT-767
✓ W2 daemon   Org/memory lane + 4 query commands              FEAT-768
✓ W2 client   RPC dispatch via capability negotiation
✓ W3          Code-graph lane in daemon (4 cg_* commands)     FEAT-769
✓ W4 daemon   Push-subscribe + LaneEvents + ConnState         FEAT-770
✓ W4 client   KnowledgeSubscription handle
✓ W5          PI_KNOWLEDGE_WORKER mode + fail-loud RPC default FEAT-771
✓ W6          /memory TUI browser + Alt+M panel               FEAT-774
✓ W7 RELATIONS File-level :RELATIONS: + :PROPERTIES: drawers   FEAT-773
✓ W8 harness   N=10 perf harness scaffolding + BenchPayload event
✓ T10.1,4,5,6 All four pre-existing memory-loop failures fixed
✓ W*.5 review waves: W5.5, W6.5, W8.5 + gap-fixes for HIGH findings
○ W5 erase    Delete in-process WarmEngine after 1-release bake-in (FUP-089)
○ W8 numbers  Run release-built harness, capture measured percentiles    (FUP-089)
○ W8 bench    push delivery P99 bench binary + cg_search corpus generator (FUP-089)
```

## Test counts at branch tip (all green, package-level)

| crate | tests | notes |
|---|---|---|
| pi-knowledge-worker | 52 (32 + 4 lifecycle + 15 protocol_v2 + 1 subscribe e2e) | +2 BenchPayload tests |
| pi-natives lib | 349 (+14 ignored) | unchanged from W5 |
| pi-natives integration | 29 + 1 + 1 + 2 + ... | rpc_dispatch_parity 1/1, subscribe_client_e2e 1/1, worker_mode 2/2 |
| pi-knowledge-core | 91 + 3 doctests | unchanged |
| pi-org-engine | 81 + 12 + 4 + 12 | file-level RELATIONS preserved |
| coding-agent memory-browser | TS strict: zero new errors | smoke tests not added (no precedent) |
| coding-agent memory-since | 4/4 | birthtime classification |

## Daemon protocol surface (15 commands)

```
init  embed_batch  embed_query
open  close  stats  subscribe  unsubscribe
search  about  neighbors  since
cg_search  cg_definition  cg_references  cg_callers
```

Events (subscribe): `index_changed`, `warm_completed`, `evicted`, `heartbeat`, `lag`, `bench_payload` (W8 instrumentation, synthetic).

## What's still in FUP-089

### W5 erase — delete in-process WarmEngine (~2-4h)

Deferred behind 1-release bake-in. The fail-loud RPC default is live; the
`PI_KNOWLEDGE_WORKER=inprocess` escape hatch preserves the WarmEngine for
offline/CI. When confidence is high, delete the WarmEngine struct, the
`ensure_warm` chain, the `EngineState::Warm` variant, and rewrite the ~12
WarmEngine-mocking tests around RPC fixtures.

### W8 measurement run (~30-60 min once release builds exist)

The harness `scripts/perf/plan315-n10.sh` is correctness-fixed (W8.5 gap-fix
addressed all 9 HIGH findings). To produce real numbers:

```
cargo build --release -p pi-natives -p pi-knowledge-worker
bash scripts/perf/plan315-n10.sh
# Output: !tasks/plans/plan-artifacts/PLAN-315/W8-perf-run-<epoch>.md
```

Five of seven gates are now measured directly. Two remain explicitly DEFERRED
in the harness and `W8-perf.md` methodology:
- `cg_search P99`: needs a code-graph corpus generator (Rust files with N
  symbols each). Hand-rolled bash addition.
- `push delivery P99`: needs a dedicated bench binary (e.g.
  `crates/pi-knowledge-worker/benches/push_latency.rs`) that calls
  `publish_bench_event` in a loop and records emit-to-receive deltas.
  The unit test in `subscribe.rs` only asserts arrival within 1s.

### Documentation finalization

Once W8 numbers are in: append the gate-table report to `W8-perf.md`,
close FUP-089, archive PLAN-315.

## Architectural decisions ratified this session

- **Fail-loud RPC default**: queries surface daemon errors with a message
  hinting at `PI_KNOWLEDGE_WORKER=inprocess`. No more silent fall-through.
  Tests in `crates/pi-natives/tests/worker_mode.rs` lock this contract.
- **Alt+M, not Ctrl+M, for /memory browser**: Ctrl+M is encoded identically
  to Enter (\r = 0x0D) on most terminals. Alt+M is unambiguous across
  legacy + Kitty CSI-u. Documented in `custom-editor.ts` and
  `hotkeys-markdown.ts`.
- **Shared-daemon RSS attribution**: per-session RSS is reported as
  `(peak daemon rss)/N`, not as a process-level metric. Documented in
  `W8-perf.md` methodology table.
- **Sustained python per session for latency**: per-query `python3 -c` spawn
  costs ~30-50ms, dwarfing the 50ms gate. The harness now uses one python
  process per session covering 110 queries (10 priming, 100 measured).
- **TabPanel contract**: `interface TabPanel extends Component { activate(): void; deactivate(): void; readonly title: string; dispose?(): void; }`. The dispose? was promoted to first-class on TabPanel during W6.5 gap-fix to support proper teardown.
- **Sequence-guarded async refresh**: SinceTab uses a `#refreshSeq` counter
  so concurrent window-toggle fetches drop stale completions cleanly.

## Artifacts directory

```
!tasks/plans/plan-artifacts/PLAN-315/
  STATUS.md            initial close (pre-this-session)
  STATUS-v2.md         THIS FILE — autonomous-session close
  W0-protocol.md       wire protocol design
  W0-ingest-audit.md   ingest-path audit
  W5.5-review.md       W5 review wave findings
  W6-research.md       /memory panel design + dispatch breakdown
  W6.5-review.md       W6 review wave findings (2 P1 + 1 P2)
  W8-perf.md           perf methodology + DEFERRED-gate rationale
  W8-research.md       harness design
  W8.5-review.md       W8 review wave findings (9 HIGH)
```
