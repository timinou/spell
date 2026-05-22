# PLAN-315 — execution status

## Shipped (commits)

| # | commit | scope |
|---|---|---|
| 1 | `fix(pi-natives,pi-workspace-cache): BUG-390 stabilise workspace test parallelism` | Pre-flight. Mutex→RwLock for `lock_test_env`; read-guard on diff_qualifier (8 tests); inline mutex on workspace_cache (2 tests); buffer_registry mutex on code_buffer flake. `cargo test --workspace` 5/5 consecutive green. |
| 2 | `feat(pi-knowledge-worker): PLAN-315 W0 + W1 — daemon rename + protocol v2` | W0 protocol design + ingest audit. W1 crate/binary/socket/env rename with legacy fallbacks; daemon `Open`/`Close`/`Stats` commands wired through `repo_cache` module; init returns `protocol_version=2` + `supported_commands`. 21/21 tests. |
| 3 | `feat(pi-knowledge-worker): PLAN-315 W2 scaffold — pi-knowledge-core dep + DaemonEmbedder` | W2 scaffold. `pi-knowledge-core` added as path dep. `DaemonEmbedder` adapter impls `pi_knowledge_core::recall::Embedder` by delegating to the shared `EmbeddingEngine` via `with_engine`. |
| 4 | `feat(pi-knowledge-worker): PLAN-315 W2 lane_org — daemon-side org/memory warm-load + commands` | W2 daemon side. `OrgLane::warm_load` scans repo, parses via `pi_org_engine`, builds BM25 + VectorIndex + TypedGraph. `search`/`about`/`neighbors`/`since` commands wired through `with_org_lane`. RepoSlot now carries `org_lane: Option<OrgLane>`. Adds `pi-org-engine` as daemon dep. **37/37 tests** (was 21). |

## Files changed

```
crates/pi-knowledge-worker/                   (renamed from pi-embedding-worker)
├── Cargo.toml                                package + bin renamed; +libc, +pi-knowledge-core
├── src/main.rs                               +Open/Close/Stats Command variants; PROTOCOL_VERSION=2
├── src/repo_cache.rs                         NEW. RepoSlot + LRU + Stats + 7 unit tests
├── src/embedder_adapter.rs                   NEW. DaemonEmbedder over EmbeddingEngine
└── tests/protocol_v2.rs                      NEW. 6 stdio integration tests

crates/pi-natives/src/embedding_worker.rs     PI_KNOWLEDGE_WORKER env (PI_EMBEDDING_WORKER fallback);
                                              knowledge.sock primary (embed.sock fallback);
                                              WORKER_BINARY_NAME=pi-knowledge-worker (+legacy);
                                              lock_test_env Mutex→RwLock+read/write variants;
                                              SocketEnv tracks legacy env vars too
crates/pi-natives/src/code_buffer.rs          BUFFER_REGISTRY_TEST_LOCK on flaky test
crates/pi-natives/src/code_path/diff_qualifier.rs   lock_test_env_read on 8 tests
crates/pi-natives/src/code_graph.rs           MutexGuard → RwLockWriteGuard
crates/pi-natives/src/recall_engine.rs        MutexGuard → RwLockWriteGuard; doc updates
crates/pi-workspace-cache/src/lib.rs          TEST_LOCK Mutex on 2 flaky tests
packages/natives/scripts/build-native.ts      Build pi-knowledge-worker; symlink legacy name
packages/natives/scripts/embed-native.ts      Both names in workerCandidates
crates/pi-knowledge-core/src/{recall,lib}.rs  Doc updates

!tasks/plans/plan-artifacts/PLAN-315/
├── W0-protocol.md                            Protocol v2 wire format design
├── W0-ingest-audit.md                        Notify watcher topology before/after
└── STATUS.md                                 This file
```

## Test counts (verified)

| crate | tests | result |
|---|---|---|
| pi-knowledge-worker | 37 | ✓ all green (11 repo_cache + 10 lane_org + 4 daemon lifecycle + 12 protocol_v2) |
| pi-natives lib | 354 | ✓ all green (14 ignored) |
| pi-workspace-cache | 5 | ✓ all green |
| pi-knowledge-core | 91 | ✓ all green (unchanged from PLAN-310) |
| pi-org-engine | 106 | ✓ all green (unchanged from PLAN-310) |
| workspace `cargo test --workspace` | full | ✓ 5/5 consecutive runs green |

## Plan progress

```
✓ Pre-flight  BUG-390 flake fix                                           DONE
✓ W0          Protocol design + ingest audit docs                         DONE (RSS baseline + red loop tests deferred to W8)
✓ W1          Daemon rename + protocol_version=2 + open/close/stats       DONE (FEAT-767)
✓ W2 daemon   Org/memory lane (warm-load + search/about/neighbors/since)  DONE (FEAT-768)
◐ W2 client   pi-natives::recall_engine RPC dispatch                      pending — see below
○ W3          Code-graph lane in daemon                                   pending
○ W4          Push-subscribe protocol                                     pending
○ W5          Cutover — delete in-process WarmEngine                      pending
○ W6          /memory TUI browser (FUP-088 W8)                            pending
○ W7          Dual-recall personal store + T10.7 + T10.10 (FUP-088 W9)   pending
○ W8          Perf gates N=10                                             pending
○ W9          Docs + close                                                pending
```

## Resume — W2 client work order

W2 daemon side is **complete**. The daemon now serves search/about/
neighbors/since over stdio (and will over socket once spawned in daemon
mode). All 37 daemon tests pass. The remaining W2 work is **pi-natives
client-side dispatch**:

### Steps

1. **Parse init response in `pi-natives::embedding_worker`**
   When `WorkerTransport` calls `init`, capture `protocol_version` and
   `supported_commands` from the response into a `Capabilities` struct on
   the transport. Add `Transport::supports(&str) -> bool` predicate.

2. **Add typed RPC methods on `WorkerTransport`**
   For each of search/about/neighbors/since, write a method that
   serializes the args, sends, awaits one line, deserializes into the
   matching response struct from `pi_knowledge_core::recall`.

3. **Wire `RecallEngineHandle::query` dispatch**
   At the top of `query`, check `transport.supports("search")`. If true:
   - ensure the daemon has the repo open (cache the handle in
     `RecallEngineHandle`); call `open` once on first query
   - emit `search` over the transport; return its hits
   If false: continue to the current in-process `WarmEngine` path.

4. **Parity test**
   In `pi-natives/tests/`, add `recall_engine_rpc_parity.rs`:
   - boot the daemon in stdio mode against a tempdir corpus
   - spawn an in-process WarmEngine over the same corpus
   - assert `RecallHit`s match (or at least overlap; vector ordering may
     differ if embedder is unreachable)

### Daemon already ships

- `Open { repo_root, include_personal, lanes }` → warm-load on demand
- `Close { repo_handle }`
- `Stats { repo_handle? }`
- `Search { repo_handle, query: RecallQuery }`
- `About { repo_handle, id }`
- `Neighbors { repo_handle, focus, hops, kinds }`
- `Since { repo_handle, ts }`
- `init` response: `{ protocol_version: 2, supported_commands: ["init",
   "embed_batch", "embed_query", "open", "close", "stats", "search",
   "about", "neighbors", "since"] }`

### Pitfalls to avoid

- `Command` enum derives `Deserialize` only — not `PartialEq` (because
  `RecallQuery` and `SinceTimestamp` don't impl `Eq`). The test that used
  `assert_eq!(command, Command::Init)` was rewritten as `matches!(...)`.
- ISO-8601 parser in `lane_org.rs` is intentionally minimal (no chrono).
  Handles `YYYY-MM-DDTHH:MM:SS[.fff][Z]`; rejects pre-1970 explicitly.
  Year-day math verified via python3 datetime for 2026-05-22 and the
  2024-03-01 leap-year boundary.
- `with_org_lane` takes a `&mut HashMap` lock, touches `last_used`, then
  hands the lane via `f(&OrgLane)`. Holding the slot mutex for the
  duration of a query is *intentional* for W2 — W4 will break this into
  a finer-grained per-lane `RwLock` when push-subscribe lands.
- The daemon **does not auto-`open`** on a `search` for an unknown repo.
  The client must call `open` first. Round-trip integration tests use
  `round_trip_sequence` to chain `open` + `search` on one daemon process.

## Remaining BUG-390-class flake

`pi-natives::embedding_worker::socket_tests::client_recovers_from_dead_socket`
flakes occasionally under workspace concurrency (~1 in 5 runs). Passes
100% when pi-natives runs alone. The dead-listener pattern races with
the daemon spawn deadline. Not blocking PLAN-315 progress; tracking
in FUP-088 alongside the other pre-existing flakes.

## Decisions in flight

- **lanes representation in RepoSlot**: chose `Vec<Lane>` for W1 because
  no lane state to store yet. W2 promotes to `HashMap<Lane, LaneState>`.
- **DaemonEmbedder.dim() = 1024 (hardcoded)**: matches
  `pi-natives::embedding_worker::EMBEDDER_DIM`. Future: have engine
  expose its model + dim via a method, single source of truth.
- **No version-mismatch handling in clients yet**: client must learn to
  refuse a daemon with `protocol_version < required`. W2 client-side
  work covers this.

## Estimated remaining effort

| wave | remaining | notes |
|---|---|---|
| W2 | 6-8h | Lift warm-build into pi-knowledge-core (the heavy lift); wire 4 commands; client dispatch |
| W3 | 4-6h | Same pattern, code-graph lane |
| W4 | 4-6h | Bidirectional streaming; need to refactor connection handler |
| W5 | 2-4h | Delete in-process; ~800 LOC removed; CI verification |
| W6 | 6-10h | TUI panel from scratch; depends on existing TUI crate scaffolding |
| W7 | 3-4h | Dual-recall flag + T10.7 RELATIONS-drawer fix + un-skip T10.10 |
| W8 | 3-4h | Perf harness; N=10 sessions; record numbers |
| W9 | 1-2h | Docs sweep + state transitions |

Total remaining: ~30-45 hours. Original 60h estimate was for full plan; ~12h shipped this session. Tracking ahead of estimate on per-wave effort but behind on calendar (single-session bootstrap).
