# Wave 2 Review — WebSocket Observability

Date: 2026-05-15
Reviewer: reviewer agent

## Verdict
PASS_WITH_FOLLOWUPS

Functional contract holds: `process_info` is gated on the existing `state` channel; `rpc_stderr` requires explicit opt-in via the new `debug` channel; both fan-outs check `connection.wants()` so other subscribers don't receive the new types; tests (server 48/48, client 19/19) and typecheck are clean on both packages. The `4096`-char per-line cap and 200-line UI ring buffer are in place. None of the issues below break the headline behavior or risk a wire-protocol break in Wave 3 — but two of them (backpressure absence and tap-listener accumulation) are real load-time bugs that should be fixed in parallel with Wave 3 rather than left as backlog.

## Findings

### High-severity
- `packages/spell-server/src/web/ws/server.ts:393-401` — **No backpressure on stderr fan-out.** `#tapStderr` (and `#tapEvents`) call `connection.send(JSON.stringify(...))` with no read of `ws.getBufferedAmount()`. Per-line is capped at 4 KB and the UI ring at 200 entries, but the server→browser WS buffer is uncapped. A subprocess emitting a high rate of valid <4 KB lines will bloat each subscribed connection's send buffer with no flow control. Bun's `ServerWebSocket` exposes `getBufferedAmount()`; gate forwarding on it (e.g. drop / coalesce when above a high-water mark).
- `packages/spell-server/src/web/ws/server.ts:393-401` (and `:382-391` for the pre-existing events tap) — **Listener leak on resubscribe and on WS disconnect.** Every WS `subscribe { channels: ["debug"] }` invokes `hub.subscribeStderr(...)` and the returned unsubscribe handle is never stored. Toggling the debug panel off/on N times via `App.svelte#onToggleDebug` registers N hub-side listeners that each fire on every line for the rest of the spawned session's lifetime. `WebConnection.dispose()` only clears `#subs` — it does not call the hub-side unsubscribe handles either, so each closed WS leaves dead closures pinned to the spawned record (they call `connection.wants()` → false and `connection.send()` → silent ws-send error). Recommend a `Map<sessionId, () => void>` on `WebConnection` that stores the unsubscribe handles produced by `subscribeEvents` / `subscribeStderr`, replaced on resubscribe and drained in `dispose()`.

### Medium-severity
- `packages/spell-server/src/rpc/rpc-client.ts:336-348` — **Stderr forwarded verbatim; no denylist scrub.** `#handleStderrLine` logs the line at debug level AND emits it to listeners unchanged. The spell CLI itself does not currently print full credentials, but `packages/ai/src/auth-storage.ts:2111` logs `key prefix: ${envKey.substring(0, 10)}...` to stderr (10 characters of the API key), and any unhandled Bun rejection prints stack traces with stringified arguments that may include fetch options. With the new `debug` channel these reach authenticated browser clients unredacted. Suggested mitigation: a small regex denylist applied before emit — `Authorization:`, `Bearer `, `x-api-key`, `anthropic-api-key`, `sk-ant-…`, `sk-…`, JWT `eyJ…`. (Same scrub should ideally cover the debug log call on the same line.)
- `packages/spell-server/src/web/session/web-session-hub.ts:152-160` — **Warmup `setTimeout` not tracked.** The 100 ms warmup `setTimeout(tick, 100)` is never assigned to the record and therefore never cancelled by `#removeRecord`. If the session is killed inside that 100 ms window (or the RPC dies during ready handshake), the warmup tick still fires after removal: `#sampleProcessInfo` reads `/proc/<dead-pid>/stat` (returns `null` → `rssBytes=0`, `cpuPercent=0`) and emits a `process_info` sample for a session the WS clients have already been told was removed. Fix: store the timeout on the record alongside `processInfoTimer` and `clearTimeout` it in `#removeRecord`.
- `packages/spell-team-chat/src/lib/protocol.ts:156` — **Wire type drift: `process_info.ts` missing on client.** Server `ProcessInfoEvent` (spell-server/src/web/ws/protocol.ts:11-19) has `ts: number` required and `server.ts:128` emits it. The client `WsServerMessage` union declares `process_info` without `ts`; `App.svelte:75` correspondingly drops it. Either include `ts` on the client wire union and forward it (the client `ProcessInfoEvent` sub-interface used internally would need it too if exposed in UI), or remove `ts` from the server emit. The two protocol files must stay in lockstep — the Wave 2 spec called this out.

### Low-severity
- `packages/spell-team-chat/src/lib/protocol.ts:157` — `rpc_stderr.ts` is required on the server (`spell-server/src/web/ws/protocol.ts:22-27` + `server.ts:402`) but typed `ts?: number` (optional) on the client wire union. Not a runtime bug (`appendStderr` defaults to `Date.now()`), but inconsistent with the spec; make it required.
- `packages/spell-server/src/web/session/web-session-hub.ts:287-318` — **PID reuse window.** Sampler reads `/proc/<pid>/stat` using a closure-captured `pid`. Between subprocess exit and `child.exited` propagating into `#removeRecord`, the kernel could reuse the pid; the sampler would then report an unrelated process's RSS. Rare under low churn, but trivially defensible: skip sampling when `record.rpcClient.alive === false`, or compare `/proc/<pid>/comm` to the spell binary name.
- `packages/spell-team-chat/src/components/DebugPanel.svelte:49-51` — Stderr tab renders an empty `<pre>` when `stderrLog` is empty. The Process tab shows a "No data yet." muted note in the equivalent case. Mirror that hint for parity.
- `packages/spell-server/src/web/ws/server.ts:241-247` — **`debug` channel shares the bearer-token gate with `events`/`artifacts`/`state`; no extra capability check.** Holding the bearer = can subscribe to any spawned session's stderr, including ones spawned by a different `ownedBy`. Same policy as the pre-existing channels, but `debug` is a strictly higher-trust feed. Follow-up: introduce a `debug:read` scope or owner-only ACL before any multi-tenant deployment.
- `packages/spell-team-chat/src/App.svelte:142-148` — `onToggleDebug` only subscribes the *current* session's `debug` channel. Selecting a different session while the panel is open silently leaves it on stale data — the new session is never subscribed to `debug`. Either subscribe on `app.select(...)` while `debugOpen`, or include `debug` in the channel list pushed on `session_list`/`session_added` whenever `debugOpen` is true (the existing logic for `state`/`events` already mirrors this pattern).
- `packages/spell-server/test/web/process-info.test.ts:30-45` — the stub `makeStubClient` returns an object missing several `RpcClient` methods (e.g. `prompt`, `abort`); the cast `as unknown as RpcClient` papers over it. Works because the hub only calls `onEvent` / `onStderr` / `pid` / `send` / `kill` in this code path, but future hub additions can silently break the stub. Minor — consider a typed `Pick<RpcClient, ...>`.

## Required fixes before Wave 3
- none (verdict is PASS_WITH_FOLLOWUPS)

## Suggested follow-ups (non-blocking)
- Backpressure: gate `connection.send` on `ws.getBufferedAmount()` for the high-volume channels (`debug`, `events`). **High.**
- Store the per-subscription unsubscribe handles on `WebConnection`, replace on resubscribe, drain on `dispose()`. **High.**
- Denylist regex scrub on stderr lines before emit + debug log. **Medium.**
- Track + clear the warmup `setTimeout` in `WebSessionHub`. **Medium.**
- Make `process_info.ts` present on the client wire union and pass through to the store; mark `rpc_stderr.ts` required. **Medium.**
- PID-reuse defense (skip sample when `!record.rpcClient.alive`). **Low.**
- "No stderr yet." hint in `DebugPanel`. **Low.**
- Capability split for the `debug` channel (owner-only or `debug:read` scope). **Low (deployment-shape dependent).**
- Re-subscribe `debug` on session switch while panel is open. **Low.**

## Test evidence
- `bun --cwd packages/spell-server test test/web`: **48 pass / 0 fail** (93 expect() calls, 3.40 s).
- `bun --cwd packages/spell-team-chat run test:unit`: **19 pass / 0 fail** (44 expect() calls, 55 ms).
- `bun --cwd packages/spell-server run check`: **clean** (`tsgo -p tsconfig.json`, no diagnostics).
- `bun --cwd packages/spell-team-chat run check`: **clean** (`svelte-check`, 284 files, 0 errors, 0 warnings).

## Surface stats
Server side (modified or added in Wave 2):
- `src/web/ws/protocol.ts` — +27 LOC for `Channel "debug"`, `ProcessInfoEvent`, `RpcStderrEvent`, union extension.
- `src/rpc/rpc-client.ts` — +~40 LOC: rewritten `#consumeStderr` (line-buffered, cross-chunk), `#handleStderrLine`, `onStderr`, `get pid`.
- `src/web/session/web-session-hub.ts` — +~120 LOC: `ProcessInfoSample`, `readProcStat`, `#sampleProcessInfo`, sampler timer wiring, `subscribeStderr`, `onProcessInfo`, defensive `onStderr` guard.
- `src/web/ws/server.ts` — +~25 LOC: `onProcessInfo` fan-out (`state` channel), `#tapStderr`, `subscribe` handler wiring.
- `test/web/process-info.test.ts` — new (101 LOC, 2 tests).
- `test/web/stderr-tap.test.ts` — new (69 LOC, 2 tests).

Client side:
- `src/lib/protocol.ts` — +~20 LOC: `Channel "debug"`, `ProcessInfoEvent`/`RpcStderrEvent` sub-interfaces, wire-union additions.
- `src/lib/reducers.ts` — +~15 LOC: `latestProcessInfo`, `stderrLog` on core; `appendProcessInfo`, `appendStderr` reducers; init field changes.
- `src/lib/stores.svelte.ts` — +~10 LOC: `noteProcessInfo`, `noteStderr`.
- `src/components/DebugPanel.svelte` — new (136 LOC).
- `src/components/Shell.svelte` — +~10 LOC: debug toggle + `DebugPanel` mount.
- `src/App.svelte` — +~25 LOC: `process_info`/`rpc_stderr` routing, conditional `debug` subscribe on session_list/session_added, `onToggleDebug` plumbing.
- `test/unit/reducers.test.ts` — +3 tests for the new reducers (~30 LOC).

Estimated net Wave 2 diff: **~440 LOC source + ~200 LOC tests = ~640 LOC**.

New runtime deps: **none** (server reads `/proc/<pid>/stat` via `Bun.file`; client uses no new packages).
