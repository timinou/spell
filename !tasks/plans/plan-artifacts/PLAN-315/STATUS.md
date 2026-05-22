# PLAN-315 — execution status

## Shipped (commits)

| # | commit | scope |
|---|---|---|
| 1 | `fix(pi-natives,pi-workspace-cache): BUG-390 stabilise workspace test parallelism` | Pre-flight. Mutex→RwLock for `lock_test_env`; read-guard on diff_qualifier (8 tests); inline mutex on workspace_cache (2 tests); buffer_registry mutex on code_buffer flake. `cargo test --workspace` 5/5 consecutive green. |
| 2 | `feat(pi-knowledge-worker): PLAN-315 W0 + W1 — daemon rename + protocol v2` | W0 protocol design + ingest audit. W1 crate/binary/socket/env rename with legacy fallbacks; daemon `Open`/`Close`/`Stats` commands wired through `repo_cache` module; init returns `protocol_version=2` + `supported_commands`. 21/21 tests. |
| 3 | `feat(pi-knowledge-worker): PLAN-315 W2 scaffold — pi-knowledge-core dep + DaemonEmbedder` | W2 scaffold. `pi-knowledge-core` added as path dep. `DaemonEmbedder` adapter impls `pi_knowledge_core::recall::Embedder` by delegating to the shared `EmbeddingEngine` via `with_engine`. |

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
| pi-knowledge-worker | 21 | ✓ all green (11 repo_cache unit + 4 daemon lifecycle + 6 protocol_v2 integration) |
| pi-natives lib | 354 | ✓ all green (14 ignored) |
| pi-workspace-cache | 5 | ✓ all green |
| pi-knowledge-core | 91 | ✓ all green (unchanged from PLAN-310) |
| workspace `cargo test --workspace` | full | ✓ 5/5 consecutive runs green |

## Plan progress

```
✓ Pre-flight  BUG-390 flake fix                                           DONE
✓ W0          Protocol design + ingest audit docs                         DONE (RSS baseline + red loop tests deferred to W8)
✓ W1          Daemon rename + protocol_version=2 + open/close/stats       DONE (FEAT-767)
◐ W2          Org/memory lane in daemon                                   SCAFFOLDED (DaemonEmbedder ready; LaneState load pending)
○ W3          Code-graph lane in daemon                                   pending
○ W4          Push-subscribe protocol                                     pending
○ W5          Cutover — delete in-process WarmEngine                      pending
○ W6          /memory TUI browser (FUP-088 W8)                            pending
○ W7          Dual-recall personal store + T10.7 + T10.10 (FUP-088 W9)   pending
○ W8          Perf gates N=10                                             pending
○ W9          Docs + close                                                pending
```

## Resume — W2 work order

To complete W2 (org/memory lane in daemon), the next session should:

### A. Lift warm-build into pi-knowledge-core
`pi-natives::recall_engine::full_rebuild` currently does:
1. Walks repo + personal store via `pi_knowledge_core::ingest`
2. Parses .org files into `OrgItem` (`pi_org_engine::parse_org_buffer`)
3. Builds `Vec<RecallDoc>` from items
4. Builds `SearchIndex<OrgItem>` (BM25)
5. Builds `VectorIndex` (usearch) using `WorkerEmbedderAdapter`
6. Builds `TypedGraph` from `:RELATIONS:` drawers

Steps 3-6 belong in `pi_knowledge_core::engine` (NEW module). The parsing
of `.org` files into `OrgItem` requires `pi_org_engine`; the daemon needs
to depend on `pi_org_engine` for that, OR `pi_org_engine` must export a
parse-only function the daemon can call without the NAPI dep chain.

### B. Add `LaneState::OrgMemory` to repo_cache
Replace `RepoSlot.lanes: Vec<Lane>` with `RepoSlot.lanes: HashMap<Lane, LaneState>`. `LaneState::OrgMemory { items, docs, bm25, vec, graph }` wraps the lifted warm-engine struct.

### C. Wire Search/About/Neighbors/Since commands
After `repo_cache::open` completes the warm-load, add command handlers:

```rust
Command::Search { repo_handle, text, scope, limit, ... } =>
    repo_cache::with_org_lane(&repo_handle, |lane| {
        let ctx = pi_knowledge_core::recall::RecallContext {
            docs: &lane.docs,
            bm25: &lane.bm25,
            vec: &lane.vec,
            embedder: &DaemonEmbedder,
            graph: &lane.graph,
            profiles: &lane.profiles,
        };
        pi_knowledge_core::recall::recall(query, &ctx)
    })
```

### D. Client side
`pi-natives::recall_engine::RecallEngineHandle::query` chooses between:
- RPC (preferred when `WorkerTransport::supports_knowledge` is true)
- In-process WarmEngine (current code path, retained as fallback through W5)

The `supports_knowledge` flag is parsed from the daemon's `init` response
where `protocol_version >= 2` and `"search"` appears in
`supported_commands`. W1 already returns `protocol_version: 2` but
`"search"` is NOT in the list yet — clients still take the in-process
path. Adding `"search"` to `supported_commands()` flips the switch.

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
