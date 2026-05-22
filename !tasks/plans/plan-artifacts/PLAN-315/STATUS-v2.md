# PLAN-315 — execution status (branch `plan-315-complete`)

## Shipped this session (6 new commits on top of main)

| # | commit | scope |
|---|---|---|
| 1 | `feat(pi-knowledge-worker): PLAN-315 W4 daemon — push-subscribe protocol` | W4 daemon side: subscribe.rs module, ConnState refactor, Subscribe/Unsubscribe commands, LaneEvents per (repo, lane), warm_completed + evicted publishing, 5 unit + 4 integration tests |
| 2 | `feat(pi-natives): PLAN-315 W4 client — KnowledgeSubscription handle` | W4 client side: opens its own socket, background event reader, Drop sends Unsubscribe; e2e test confirms warm_completed delivery |
| 3 | `feat(pi-knowledge-worker): PLAN-315 W3 — code-graph lane in daemon` | W3: lane_code.rs wraps `pi_code_graph::CodeGraph`; CgSearch/CgDefinition/CgReferences/CgCallers commands; RepoSlot.code_lane + with_code_lane accessor; 7 new tests |
| 4 | `fix(coding-agent): PLAN-315 T10.6 — memory.since classifies added vs modified by birthtime` | T10.6: diffMemorySince distinguishes newly-created (birthtime > cutoff) from modified-after-creation; 4 unit tests |
| 5 | `fix(pi-natives,tests): PLAN-315 T10.4 + T10.5 memory-loop fixes` | T10.5: file-level memory.link to `#+CUSTOM_ID:` items via file-level :RELATIONS: drawer; T10.4: split timing budget into rebuild vs warm-search phases; 3 + 0 tests |
| 6 | `fix(tests): PLAN-315 T10.1 - add scope:[episode] to match test name intent` | T10.1: test name said "search returns episode by topic" but didn't scope; added `scope: ["episode"]` to make assertion match intent |

## Plan state at branch tip

```
✓ Pre-flight  BUG-390 flake fix                                 (committed on main pre-branch)
✓ W0          Protocol design + ingest audit                    (artifacts committed)
✓ W1          Daemon rename + protocol v2 + open/close/stats    FEAT-767 DONE
✓ W2 daemon   Org/memory lane warm-load + 4 query commands      FEAT-768 DONE
✓ W2 client   RPC dispatch via capability negotiation           
✓ W3          Code-graph lane in daemon (4 cg_* commands)       
✓ W4 daemon   Push-subscribe protocol + LaneEvents + heartbeat helper
✓ W4 client   KnowledgeSubscription handle
✓ W7 RELATIONS  File-level :RELATIONS: + :PROPERTIES: drawer parsing
✓ T10.1, .4, .5, .6  All four pre-existing memory-loop failures fixed
○ W5 cutover   In-process WarmEngine deletion                   FUP-089
○ W6 TUI       /memory browser panel                            FUP-089
○ W8 perf      N=10 sessions harness + hard gates               FUP-089
○ W9 docs      AGENTS.md sweep + CHANGELOG + close              this session
```

## Test counts (this branch, all green)

| crate | tests |
|---|---|
| pi-knowledge-worker | 50 (was 8 pre-PLAN-315; +42 across W1/W2/W3/W4 lanes + subscribe) |
| pi-natives lib + integration | 349 lib + 3 integration |
| pi-knowledge-core | 91 |
| pi-org-engine | 81 (was 78; +3 file-level RELATIONS/PROPERTIES tests) |
| coding-agent memory-since | 4 new |

## What still requires FUP-089 work

### W5 — cutover (delete in-process WarmEngine), 2-4h

The RPC fast-path is live and exercised by `rpc_dispatch_parity` + `subscribe_client_e2e`.
The in-process `WarmEngine` remains as fallback. Deleting it requires:
- removing ~800 LOC across `recall_engine.rs`, `code_graph.rs`
- rewriting ~12 unit tests that mock the embedder at the WarmEngine layer
- introducing `PI_KNOWLEDGE_WORKER=inprocess` env knob for CI / offline

Recommended: own commit after a 1-release bake-in period to confirm
the RPC path is stable under load.

### W6 — /memory TUI browser, 6-10h

4-tab panel (search / graph / recent / since); subscribes for live
refresh; slash command + ambient Ctrl-M. Architecturally independent of
W5; the daemon (W2+W3+W4) already exposes everything the TUI needs.

Why deferred: requires investigation into `packages/coding-agent/src/modes/`
panel architecture (interactive-mode.ts, mode controllers) and a real
keybinding integration — substantial UX surface area beyond the
infrastructure scope of this session.

### W8 — N=10 perf harness, 3-4h

Multi-process orchestration test:
- spawn 10 concurrent `bun coding-agent` sessions
- synthetic 5k-symbol corpus per session
- sample `ps -o rss,pid,comm` every 2s for 60s
- measure per-command P50/P95/P99

Hard gates to verify:
- `libpi_natives.so` (release) ≤ 92.5 MB
- per-session RSS ≤ 100 MB
- total RSS N=10 ≤ 1.55 GB
- `memory.search` warm P99 ≤ 50 ms
- `cg_search` warm P99 ≤ 60 ms
- push event delivery ≤ 500 ms

## Decisions in flight (no behavior change needed)

- `Lane::CodeGraph` warm-load uses the daemon-side BM25 path; query
  vector path is reserved for future activation via the `kind` arg.
  Today's cg_search is BM25-only inside the daemon to avoid embedder
  cold-load on every query.
- `subscribe.rs` heartbeat machinery exists (`spawn_heartbeat`) but is
  not wired into per-connection threads. Connection-close detection
  happens via socket-read-zero already; heartbeat is value-add for
  cross-NAT scenarios that don't apply to local Unix sockets.
- `EventRegistry` is a static `OnceLock<EventRegistry>` singleton;
  per-test isolation in `subscribe.rs` unit tests uses fresh registries
  to avoid cross-test interference.

## Daemon protocol surface (final, this branch)

```
init        embed_batch  embed_query
open        close        stats        subscribe        unsubscribe
search      about        neighbors    since
cg_search   cg_definition cg_references cg_callers
```

15 commands. `init` advertises them in `supported_commands` so clients
can feature-detect.
