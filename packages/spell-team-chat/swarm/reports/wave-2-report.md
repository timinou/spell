# Wave 2 Report — WebSocket Observability

Date: 2026-05-15
Wave: 2 of 3
Status: COMPLETE (gated by Review 2: PASS_WITH_FOLLOWUPS)

## Delivered

### Server (packages/spell-server/)
- New event types `process_info` and `rpc_stderr` on `/web/ws`
- New `"debug"` subscription channel (opt-in firehose; `state` channel carries `process_info`)
- `RpcClient.onStderr(listener)` public API; `get pid()` getter
- `RpcClient.#consumeStderr` rewritten line-buffered with cross-chunk safety + 4096-char drop cap
- `WebSessionHub.onProcessInfo` / `subscribeStderr`; per-session 5s sampler reads `/proc/<pid>/stat` for rss + cumulative CPU
- `WebConnection.registerTap` stores hub-side unsubscribe handles and drains on dispose (closes the listener-leak finding from review)
- Tests: `test/web/process-info.test.ts` (2) + `test/web/stderr-tap.test.ts` (2)

### Client (packages/spell-team-chat/)
- Wire types in `src/lib/protocol.ts` mirror server (post-review sync, both `ts` now required)
- `appendProcessInfo` / `appendStderr` pure reducers; `SessionStateCore` extended; log capped 200
- `DebugPanel.svelte` (right slide-in, Process + Stderr tabs)
- `Shell.svelte` toggle + `App.svelte` conditional `debug` subscribe on session_added/session_list
- Tests: 3 reducer tests appended to `test/unit/reducers.test.ts`

## Test evidence
- `bun --cwd packages/spell-server run check` → clean
- `bun --cwd packages/spell-server test test/web` → **48 pass / 0 fail**
- `bun --cwd packages/spell-team-chat run check` → clean (svelte-check 284 files, 0/0)
- `bun --cwd packages/spell-team-chat run test:unit` → **19 pass / 0 fail**
- `bun --cwd packages/spell-team-chat run build` → 74 KB JS / 16 KB CSS

## Post-review patches applied
1. **P1 listener leak** — added `WebConnection.registerTap` keyed by `(sessionId, channel)`; replaces prior taps on resubscribe; drains all taps on `dispose()`. Both `#tapEvents` and `#tapStderr` now register handles.
2. **P1 wire-type drift** — added `ts: number` to client `ProcessInfoEvent` / `RpcStderrEvent`; flipped `rpc_stderr.ts` from optional to required to match server.

## Carried forward (non-blocking)
- P1 stderr WS backpressure (gate `connection.send` on `ws.getBufferedAmount()`)
- P2 stderr denylist scrub before forwarding
- P2 warmup `setTimeout` not tracked / cancelled
- P3 pid-reuse defense
- P3 "No stderr yet." UI hint for empty log
- P3 capability split for `debug` channel (owner-only)
- P3 re-subscribe `debug` on session switch while panel is open

## Surface stats
- Net diff: ~640 LOC (440 source + 200 tests) across ~12 files
- New runtime deps: none

## Gate to Wave 3
✅ All P1 contract-impacting findings resolved. Wave 3 may proceed.
