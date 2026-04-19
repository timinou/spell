# Cross-Session Edit Coordination — Design

## Problem

Every `spell` process owns its own `BufferRegistry` (per-dylib DashMap). When two
agents run against the same repo, a write by session B is only detected by
session A via the `notify-rs` watcher, asynchronously; A's in-memory buffer,
`History`, and tree-sitter tree go stale. The `code edit` tool then misresolves
targets, surfaces `ExternalModification`, or worse, succeeds against a stale
tree and clobbers B's change. `History.Revision` has no session attribution, so
an agent cannot undo its own ops without potentially reverting another
session's work.

## Design principle (operator directive)

> "equate an edit with a file change; lock time per edit request must be super
> limited — literally just lock, write, release, so editing is asynchronous
> across agents and even within sessions; gets updated if the file got updated."

Translation: **the persistent dirty buffer is abandoned for mutating paths.**
Every `code edit` is a short critical section:

```
acquire fd_lock
  fetch latest file bytes from disk
  fetch peer state from broker (intent + recent commits since baseRevision)
  re-resolve CodePath target against fresh AST
  apply structural edit
  write bytes to disk
  append journal entry
release fd_lock
broadcast commit to broker subscribers
```

Staleness is impossible by construction: we always read latest under lock.
Read-only paths (`outline`, `navigate`, `symbols`, `read`) retain the cached
`CodeBuffer` for speed; mutating paths never do.

## Components

### 1. `crates/pi-edit-broker/` (new crate, tiny Rust binary)

- Binary: `pi-edit-broker --daemonize`
- Socket: `~/.spell/edit-broker.sock`
- PID file: `~/.spell/edit-broker.pid`
- In-memory state (no DB):
  - `sessions: HashMap<SessionId, SessionRecord { pid, cwd, projectName, startedAt, openFiles, lastHeartbeat }>`
  - `fileIntents: HashMap<CanonPath, Vec<Intent { sessionId, codePath, baseRevision, expiresAt }>>`
  - `fileRecent: HashMap<CanonPath, RingBuffer<Commit { sessionId, revision, codePaths, diffHash, ts }>>` (last 64 per file)
  - `subscriptions: HashMap<CanonPath, HashSet<SessionId>>`
- Lifecycle: always-on. First client spawns the broker via `execvp`; broker
  self-daemonizes. Broker exits 30s after last client disconnects.
- Reaping: every 5s, `kill(pid, 0)` each session; deregister dead pids.
- Protocol: newline-delimited JSON over Unix stream socket.

#### Messages (client → broker)

```jsonc
{"type":"hello","sessionId":"14bf...","pid":12345,"cwd":"/abs/path","projectName":"spell","startedAt":17450...}
{"type":"subscribe","files":["/abs/a.ts","/abs/b.ts"]}
{"type":"intent","file":"/abs/a.ts","codePaths":["src/a.ts::Foo.bar#body"],"baseRevision":41,"ttlMs":5000}
{"type":"commit","file":"/abs/a.ts","revision":42,"parentRevision":41,"codePaths":["src/a.ts::Foo.bar#body"],"diffHash":"blake3:...","byteLen":2048}
{"type":"release_intent","file":"/abs/a.ts","codePaths":["src/a.ts::Foo.bar#body"]}
{"type":"heartbeat"}
{"type":"bye"}
```

#### Messages (broker → client)

```jsonc
{"type":"welcome","serverVersion":"1","peers":[{"sessionId":"...","cwd":"...","openFiles":[...]}]}
{"type":"intent_ack","file":"...","codePaths":[...],"granted":true}
{"type":"intent_conflict","file":"...","codePath":"src/a.ts::Foo.bar#body","conflictingSession":"...","peerIntentTs":17450...}
{"type":"commit_conflict","file":"...","codePath":"...","conflictingSession":"...","peerCommitTs":17450...,"peerRevision":43}
{"type":"peer_committed","file":"...","sessionId":"...","revision":43,"codePaths":[...],"diffHash":"...","ts":17450...}
{"type":"peer_joined","sessionId":"..."}
{"type":"peer_left","sessionId":"..."}
```

### 2. `crates/pi-code-engine/src/coord/` (new module)

```
coord/
  mod.rs        — re-exports + module wiring
  client.rs     — `trait CoordClient` (async-free, blocking on short budget)
  null.rs       — `NullCoordClient` — returns empty peer state, silent commits
  socket.rs     — `SocketCoordClient` — speaks broker protocol, auto-spawns broker
  journal.rs    — append-only local journal writer at ~/.spell/edit-journal/
  node_ref.rs   — derive CodePath for a tree-sitter node at edit site (uses CodePath dialect)
```

`CoordClient` trait (blocking; each method bounded by a short timeout, default
150 ms; failures are non-fatal and degrade to no-op):

```rust
trait CoordClient: Send + Sync {
  fn on_open(&self, session: &SessionId, file: &Path, revision: u64);
  fn intent(&self, session: &SessionId, file: &Path, code_paths: &[String], base_revision: u64) -> IntentResult;
  fn commit(&self, session: &SessionId, file: &Path, revision: u64, parent_revision: u64, code_paths: &[String], diff_hash: &str, byte_len: u64) -> CommitResult;
  fn recent_peer_edits(&self, file: &Path, since_ms: u64, limit: usize) -> Vec<PeerEdit>;
  fn peer_state(&self, file: &Path) -> PeerState;
  fn on_close(&self, session: &SessionId, file: &Path);
}

enum IntentResult { Granted, Conflict { peer_session: SessionId, code_path: String, peer_intent_ts: u64 } }
enum CommitResult { Ok, Conflict { peer_session: SessionId, code_path: String, peer_revision: u64, peer_commit_ts: u64 } }
```

### 3. `crates/pi-code-engine/src/buffer.rs` changes

- Add `pub fn edit_transaction(&self, session_id: &SessionId, path: &Path, edit_plan: EditPlan, coord: &dyn CoordClient) -> Result<TransactionOutcome>` to `BufferRegistry`.
  - `EditPlan` describes structural intent: resolved `CodePath` targets + the
    edit action (write/findAndReplace/etc.).
  - Method does the entire critical section described in the principle.
  - Returns `TransactionOutcome { revision, code_paths, diff_hash, byte_len, peer_edits_since_base }`.
- `History::Revision` gains `{ session_id: String, code_paths: Vec<String>, parent_revision: u64 }`.
  - Whole-file fallback when edit doesn't cleanly align with a CodePath:
    store a single path-only marker `"src/a.ts::*"`.
- New error: `CodeEngineError::PeerConflict { session: SessionId, file: PathBuf, code_path: String, peer_revision: u64, peer_commit_ts: u64 }`.
- Deprecate `save()` and `save_with_watcher()` as public APIs; writes go through
  `edit_transaction`. The old `edit()` + `save()` pair remains only for the
  in-process editor buffer flow used by tests and non-mutating consumers.
- Read-only callers (`outline`, `navigate`, `symbols`) continue to use the
  cached `open()` path; when a commit arrives for an open file via
  `SocketCoordClient`, the registry invalidates the cache proactively.

### 4. `crates/pi-code-engine/src/file_lock.rs`

- Lower `SAVE_LOCK_BUDGET` is unchanged; the critical section is already the
  narrowest useful scope.
- Add `pub fn with_exclusive_lock_for_session<T>(path, session_id, budget, f)` that
  records the session id holding the lock for debug/telemetry; no semantic
  change.

### 5. `packages/natives/src/code-buffer/` (NAPI bridge)

- `CodeBufferOptions` gains `sessionId?: string`. Required for any mutating
  command (`edit`, `findAndReplace`, `rename`, `delete`, etc.); omitted for
  `outline`, `read`, `navigate`, `symbols` (defaults to anonymous read-only).
- New NAPI commands (dispatched through `command`):
  - `coord_status` → `{ brokerUp: bool, peers: PeerInfo[], socketPath: string }`
  - `coord_peer_activity` → `{ file: string, edits: PeerEdit[] }` (recent commits on file)
  - `coord_journal_tail` → `{ file: string, entries: JournalEntry[] }` (last N entries)
- Error surface: `CodeErrorOutput` gains optional `peerConflict?: { sessionId, codePath, peerRevision, peerCommitTs }`.

### 6. `packages/coding-agent/src/tools/code.ts` integration

- Every `executeCodeBuffer` call routed through a helper `callCodeBuffer(ctx, opts)` that injects `sessionId: ctx.session.sessionManager.getSessionId()`.
- `PeerConflict` → `ToolError` with structured details and remediation copy:
  `"Peer session {id} committed {codePath} at {ts}. Re-run the edit; the engine
  will auto-resolve against the fresh tree."` (The retry is cheap because the
  edit transaction is idempotent — if the new tree still has the target, the
  retry wins.)
- Tool output renderer shows a "peer activity" footer when
  `coord_peer_activity` returns non-empty entries.

### 7. TUI surface

- New status-line segment (`packages/coding-agent/src/modes/components/status-line/segments.ts`):
  `coord: 2 peers · last touched src/foo.ts 12s ago`.
- `code edit` preview footer in `packages/coding-agent/src/modes/components/tool-execution/`:
  shows recent peer CodePaths for the same file when present.
- Conflict error renders as a structured panel with peer session id + CodePath.

## Journal format

Path: `~/.spell/edit-journal/<repo-hash>/<file-hash>.jsonl`.
`repo-hash = blake3(canonicalize(workspace_root))[0..16]`.
`file-hash = blake3(canonicalize(file_path))[0..16]`.

Each line:

```jsonc
{
  "ts": 1745030400000,
  "sessionId": "14bfce727e583e3c", # pragma: allowlist secret
  "pid": 12345,
  "kind": "commit",
  "revision": 42,
  "parentRevision": 41,
  "codePaths": ["src/server.ts::Server.handle#body"],
  "diffHash": "blake3:a1b2...",
  "byteLen": 2048
}
```

The journal is the **persistent** attribution record; the broker holds only the
live ring buffer. On restart, read-only queries replay the journal tail to
reconstruct recent peer activity even when the broker just started.

## Undo/redo (best-effort)

`History::undo_scoped(session_id)` walks the revision parent chain and skips
revisions whose `session_id` does not match. When skipping a peer revision, it
records `skipped: Vec<RevisionSummary>` in the result so the agent/TUI can say
"skipped 2 revisions from peer B". Redo is symmetric. No cross-session locking
or ordering guarantee — explicitly best-effort per directive.

## Failure modes & degradation

| Scenario | Behavior |
| --- | --- |
| Broker dead, socket missing | Client attempts one `execvp`. If spawn fails, falls back to `NullCoordClient`. Journal still written. `code edit` continues; no peer awareness. |
| Broker accepts connection but hangs | Each RPC has a 150 ms budget; on timeout, degrades to `NullCoordClient` for that call. |
| Journal dir unwritable | Logged once per session via `@oh-my-pi/pi-utils` logger; operations continue without journal. |
| Two sessions intent the same CodePath within 5 ms | First `intent` wins; second receives `intent_conflict`. Loser retries after back-off. |
| Lock contention on `fd_lock` | Existing 500 ms budget; `LockTimeout` error as today. Caller retries. |
| `CodePath` derivation fails (edit not aligned to a named node) | Record as whole-file (`file::*`) marker. TUI shows file path only. |

## Tests (contract-level, not implementation)

- `crates/pi-code-engine/tests/coord.rs`
  - Stateless edit re-reads under lock when peer wrote between reads.
  - Peer-intent conflict returns structured error with conflicting session id.
  - Commit broadcasts to subscribers with correct `parentRevision`.
  - Journal entry written atomically per commit; replay reconstructs state.
  - `undo_scoped` skips peer revisions and reports skipped summaries.
- `crates/pi-edit-broker/tests/lifecycle.rs`
  - Auto-spawn by first client; subsequent client connects to same socket.
  - `kill(pid, 0)` reaping deregisters dead sessions within 5s.
  - Grace-period exit: last client disconnects, broker terminates after 30s.
  - Socket file removed on clean exit; auto-replaced on next spawn.
- `packages/natives/test/code-buffer-coord.test.ts`
  - `sessionId` required for mutating commands; omission returns `MISSING_SESSION_ID`.
  - `PeerConflict` surfaces in `CodeErrorOutput.peerConflict` with structured fields.
  - `coord_status` returns broker status and peer list.
- `packages/coding-agent/test/tools/code-coord.test.ts`
  - Tool output renders peer-activity footer when recent commits present.
  - Conflict error renders with remediation copy and is re-triable.
- `packages/coding-agent/test/session/edit-coordinator.test.ts`
  - Every mutating `code edit` call includes `sessionId`.
  - Read-only calls pass through without coordination overhead.

## Non-goals (Phase 1)

- Concurrent character-level merge (Loro replacement for Rope). Revisit in
  Phase 2 once the coordination skeleton stabilizes. The journal format is
  designed to accept future `op: [...]` CRDT payloads without breaking
  compatibility.
- Cross-host coordination. Broker is local-only (Unix socket).
- Semantic conflict resolution (e.g., "you deleted a function, peer added a
  call to it"). Out of scope — peer-aware reload + structured errors are the
  surface; the agent decides.
- Windows support. Current `pi-code-engine` is Unix-first; broker uses Unix
  socket. Windows named-pipe support is a future deliverable.

## Phase 1 landed (2026-04-19)

Phase 1 is now in the tree end-to-end.

- Engine: `crates/pi-code-engine/src/coord/` plus `BufferRegistry::edit_transaction` in `src/buffer.rs`, atomic persisted writes, deprecated non-transactional save entrypoints, and journal-backed attribution.
- Broker: `crates/pi-edit-broker/` protocol, daemon lifecycle, auto-spawn, and stale-socket handling tests.
- NAPI: `crates/pi-natives/src/lib.rs` wires `SocketCoordClient` into the shared registry; `crates/pi-natives/src/code_buffer.rs` exposes `coord_status`, `coord_peer_activity`, and `coord_journal_tail` with mutating-command `sessionId` enforcement.
- coding-agent: `packages/coding-agent/src/session/edit-coordinator.ts`, `tools/code.ts`, `tools/tool-errors.ts`, and `tools/code-result.ts` inject session ids, surface `PeerConflict`, and render peer activity.
- UI/tests: `packages/coding-agent/src/modes/components/status-line/segments.ts` renders the coord segment; focused tests cover two-session engine flow, subagent session attribution, peer-activity footer formatting, broker spawn/stale-socket behavior, and status-line rendering.

Residual closeout completed on 2026-04-19: BUG-303 finished the remaining direct managed-buffer mutating call sites; BUG-305 widened code-tool wiring expectations for the trailing `coord_peer_activity` call; FEAT-593 encoded the missing coverage scenarios; FUP-064 recorded the Loro Phase-2 recommendation.

## Rollout

Phase 1 — foundation (Wave 1):
  journal, CodePath extractor, History attribution, NullCoordClient, error types.

Phase 2 — broker (Wave 1, parallel):
  pi-edit-broker crate, protocol types, binary skeleton, auto-spawn.

Phase 3 — engine integration (Wave 2):
  SocketCoordClient, `edit_transaction`, BufferRegistry stateless mutation path.

Phase 4 — NAPI + TS (Wave 3):
  sessionId plumb-through, new NAPI commands, coord surface in `code.ts`.

Phase 5 — TUI + telemetry (Wave 4):
  status-line segment, preview footer, structured error rendering.
