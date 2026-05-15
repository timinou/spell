# Final Review — Spell Team Chat Interactive Sessions Swarm

Date: 2026-05-15
Reviewer: reviewer agent
Waves reviewed: 1, 2, 3

## Verdict
**REVISE** — infra is real and well-built; the headline claim is not.

The cassette infrastructure (Wave 1) and WebSocket observability (Wave 2) are
correctly implemented, deterministic, type-safe, and covered by genuine unit/integration
tests. However the swarm's stated goal — "prove interactive sessions actually work
end-to-end" — is **not** demonstrated by Wave 3. The headline E2E test silently passes
via a fall-through diagnostic path even when the spawned subprocess never produces an
assistant reply (verified by re-running the suite locally: 3 tests / 0 fail / **2**
expect() calls). Two of the three `it` blocks in `interactive.test.ts` early-return
without any assertion in the failure path. The Wave 3 report is honest about this in
prose ("passes as a skip-with-diagnostic") but the test code itself is not — a CI
green light from this suite carries no signal about whether interactive sessions work.

## Headline claim audit

The Wave 3 report claims "interactive sessions work" because `81 pass / 0 fail`. Truth:

- **Genuinely proven** (real assertions, real coverage):
  - Cassette infra: record→replay buffered round-trip, SSE chunk-order preservation,
    miss-throws-with-fingerprint, redaction of `Authorization`, fingerprint stability
    across body-key reordering — all in `packages/ai/test/cassette/cassette.test.ts`
    (5 tests, 13 expects).
  - Anthropic provider env wiring: mode validation gates record vs replay vs
    passthrough; unknown values fall to passthrough (post-Wave-1 fix at
    `packages/ai/src/providers/anthropic.ts:646-657`).
  - WebSocket fan-out gating: `process_info` is dispatched only when
    `connection.wants(sessionId, 'state')`; `rpc_stderr` only when
    `connection.wants(sessionId, 'debug')` — verified at server.ts:128-141 +
    393-404.
  - Listener-leak fix: `WebConnection.registerTap` stores hub-side unsubscribe
    handles per `(sessionId, channel)`, replaces on resubscribe, drains in
    `dispose()` — verified at connection.ts:80-104.
  - Stderr line buffering: cross-chunk safe, 4 KB per-line cap drop applied before
    listener fan-out — verified at rpc-client.ts:354-388.
  - Wire-protocol parity: server `WsServerMessage` `process_info` and `rpc_stderr`
    variants are field-identical to the client mirror in
    `packages/spell-team-chat/src/lib/protocol.ts:175-176` — both have `ts: number`
    required.
  - Reducer correctness: `appendProcessInfo` keeps latest sample; `appendStderr`
    appends + caps at 200 — covered by 3 unit tests.

- **Skip-as-pass** (test reports green without ever asserting the headline):
  - `interactive.test.ts:88-122` "renders 'alive' in the chat" — when the
    `assistantBubble.waitFor` times out AND no `fingerprint=` cassette-miss bubble
    is found, the catch falls into a `console.log(...)` and `return` with
    **zero `expect()` calls**. Verified by local run output:
    `[interactive.test.ts] Headline assertion timed out without a cassette-miss
    error.` followed by `3 pass / 0 fail / 2 expect() calls`.
  - `interactive.test.ts:124-141` "process_info pid appears" — early-returns
    silently when `pid <= 0` (which is always the case in this environment because
    the headline failed first).
  - `interactive.test.ts:144-155` "stderr tab subscribes" — early-returns when
    debug panel is not visible.

  Net: of the 3 `it` blocks in `interactive.test.ts`, **0** assert the prompt→reply
  cycle; **0** assert that `process_info` arrived for a real spawned session;
  **1** asserts `toast.count() === 0` *if* the panel happens to open. The
  "headline E2E proves interactive sessions" claim in the Wave 3 report is
  unsupported by the test suite as committed.

- **Not proven** (no test exists):
  - Real prompt → real subprocess → real Anthropic-shaped request → real cassette
    replay → real assistant bubble in the DOM. The hand-crafted fixture at
    `test/cassettes/e28762b6…json` was authored against a stub body (no system
    prompt, no tools, no beta headers) and its fingerprint structurally cannot
    match what the actual `spell --mode rpc` subprocess sends through the
    Anthropic SDK — the second cassette in the same directory
    (`692f937957…json`) shows the real shape includes
    `anthropic-beta: claude-code-20250219,oauth-2025-04-20,…` plus `x-stainless-*`
    headers. Until a real recording is committed, the headline test cannot
    pass non-trivially.
  - Backpressure on `rpc_stderr` fan-out under load.
  - `process_info` post-`#removeRecord` race (warmup `setTimeout` not cancelled).

## Issues by severity

### Blocking (must fix before claiming "interactive sessions work")
- **interactive.test.ts:112-122** — headline test must `throw` (not silently
  `return`) on the no-cassette-miss path, or the entire `it` must be guarded
  by an `it.skipIf(!cassetteMatchesRealRequest)` pre-check. Today CI cannot
  distinguish "interactive works" from "RPC subprocess crashed before reaching
  Anthropic". This is the headline claim's only real evidence path.
- **test/cassettes/e28762b6…json** — stub fixture cannot ever match real SDK
  request shape; either delete and replace `it` with `it.todo`, or commit a real
  recorded cassette. Leaving the stub in place actively misleads.

### High (fix this cycle)
- **server.ts:393-404** — `rpc_stderr` fan-out has no WebSocket backpressure
  (`getBufferedAmount()` not consulted). Wave 2 P1; carried forward unfixed.
  Acceptable for single-developer demo, blocking for any production debug-channel use.

### Medium (fix soon)
- **rpc-client.ts:375-388** — stderr forwarded raw, no secrets scrub. `auth-storage.ts`
  prints first 10 chars of API key to stderr; with `debug` channel those reach
  authenticated browser clients. Wave 2 P2; carried forward unfixed.
- **web-session-hub.ts:167-170** — warmup `setTimeout` not tracked, not
  cancelled in `#removeRecord`. Narrow window where post-removal `process_info`
  for `rss=0/cpu=0` can leak. Wave 2 P2; carried forward unfixed.
- **interactive.test.ts:124-156** — aux tests (`process_info pid`, `stderr tab`)
  early-return silently when their preconditions aren't met. Same anti-pattern
  as headline.

### Low (nice to have)
- **web-session-hub.ts:285-320** — pid-reuse window in sampler; trivial
  defense via `record.rpcClient.alive` check. Wave 2 P3.
- **server.ts:241-247** — `debug` channel shares bearer gate with lower-trust
  channels; needs `debug:read` scope or owner-only ACL before multi-tenant
  deployment. Wave 2 P3.

## Test matrix (reviewer's run)

| Suite | Pass | Fail | Skip-as-pass | Notes |
|---|---|---|---|---|
| `packages/ai test/cassette` | 5 | 0 | 0 | 13 expects, all real |
| `packages/spell-server test/web` | 48 | 0 | 0 | 93 expects, all real |
| `packages/spell-team-chat test:unit` | 19 | 0 | 0 | 44 expects, all real |
| `packages/spell-team-chat test/e2e/journey` | 6 | 0 | 0 | 7 expects (sparse but real) |
| `packages/spell-team-chat test/e2e/interactive` | 3 | 0 | **3** | only 2 expects across 3 tests |
| **Total** | **81** | **0** | **3** | headline claim rests on 3 silent-pass tests |

Type-checks (`tsgo` for spell-server, `svelte-check` for spell-team-chat) are
both clean. No regressions in non-Wave packages observed.

## Risks shipped

- `packages/spell-server/src/web/ws/server.ts:393-404` — **High**. No backpressure
  on stderr fan-out; uncapped server-side WS buffer growth under flood.
- `packages/spell-server/src/rpc/rpc-client.ts:375-388` — **Medium**. Stderr lines
  forwarded to authenticated browser clients without secret scrub.
- `packages/spell-server/src/web/session/web-session-hub.ts:167-170` — **Medium**.
  Warmup `setTimeout` not cancellable; post-removal `process_info` race.
- `packages/spell-team-chat/test/e2e/interactive.test.ts:88-156` — **High** (test
  honesty). Three skip-as-pass branches that turn the headline claim into
  unfalsifiable green.
- `packages/spell-server/src/web/session/web-session-hub.ts:285-320` — **Low**.
  PID-reuse race in sampler.
- `packages/spell-server/src/web/ws/server.ts:241-247` — **Low (deployment-shape
  dependent)**. Debug channel ACL flat with other channels.

## Close-out tasks before user-facing ship

1. **Record a real Anthropic cassette** with a current `spell --mode rpc` build
   against `claude-3-5-haiku-latest` and commit it. Delete the
   stub `e28762b6…json` (and the orphaned `692f937957…json` if it was
   recorded against `localhost:8080`). Confirm `defaultFingerprint(req)` of the
   real subprocess request matches the new cassette's filename.
2. **Make the headline test loud on real failure**: replace the second
   `console.log + return` branch (interactive.test.ts:114-122) with `throw new
   Error("interactive headline failed without a cassette-miss bubble — record cassette or debug RPC startup")`,
   so green-pass requires evidence.
3. **Apply stderr secret-scrub** (Wave 2 P2): regex denylist for `Bearer`,
   `sk-…`, `eyJ…\.…\.…`, plus the header names already in `redact.ts`. Apply
   before `listener(line)` AND before `logger.debug`.
4. **Wire WS backpressure on `debug` channel** (Wave 2 P1): drop or coalesce when
   `ws.getBufferedAmount() > 1 MB`.
5. **Track + clear warmup setTimeout** in `WebSessionHub.#removeRecord`.
6. **Optional**: introduce `debug:read` scope for multi-tenant readiness.

## Surface

- Source LOC added: ~880 (cassette 276 + server-side observability ~185 net new
  + client-side observability ~205 net new + ~30 anthropic provider wire +
  ~120 helper extension)
- Test LOC added: ~452 (cassette unit 142 + server stderr/process-info 170 +
  client reducer ~30 + interactive E2E 180 — minus pre-existing) ≈ ~520 total
  including 110 lines of fixture JSON
- Files added: 13 (5 cassette source + 1 cassette unit test + 2 cassette
  fixtures + 2 server test files + 1 DebugPanel component + 1 e2e file +
  1 helper extension delta)
- Files modified: ~10 (anthropic provider, ws/protocol.ts, ws/server.ts,
  ws/connection.ts, web-session-hub.ts, rpc-client.ts on server side; protocol.ts,
  reducers.ts, stores.svelte.ts, Shell.svelte, App.svelte, README.md on client
  side; reducers.test.ts extended; test-server.ts extended)
- New runtime deps: **0** (verified — cassette uses `node:crypto`, `node:fs/promises`,
  `Bun.file`/`Bun.write`; observability uses `node:fs` for `/proc/<pid>/stat`)
- New dev deps: **0** (Playwright was a pre-existing devDep from
  `4cc75cd70 test(spell-team-chat): two-tier suite`; the cassette fixture is
  hand-crafted JSON, no recording library required)

## Bottom line

The Wave 3 report's prose is honest about the skip-as-pass; the test code is
not. As-is, this swarm ships **strong cassette + observability infrastructure
with no end-to-end proof that the interactive session pipeline works**. Do not
let the "81 pass / 0 fail" headline mislead the next maintainer: ~78 of those
tests prove their respective units; the 3 in `interactive.test.ts` prove only
that the harness itself doesn't crash. Close out task #1 (record a real cassette)
and task #2 (make the headline loud), and this becomes APPROVE.

---

## Post-review patches applied (after first FinalReview)

Reviewer flagged two blockers:
1. **Headline test silently passing** (interactive.test.ts:112-122)
2. **Stub fixture cannot match real SDK shape**

### Applied
- Rewrote `test/e2e/interactive.test.ts`:
  - Three cases that need a recorded cassette are now `it.todo` — they appear in `bun test` output as TODO, not silent pass.
  - The "attempts a real prompt" case now `throw`s explicitly when neither a `.bubble.assistant` containing "alive" appears nor a `fingerprint=` cassette-miss error surfaces within 30s. No more fall-through `return`.
  - Added a structural check (`cassette replay is enabled in the spawned subprocess env`) that asserts the env plumbing is in place without needing a matching fixture.

### Resulting test state for interactive.test.ts
```
1 pass    cassette replay env wiring
3 todo    headline / process_info / stderr — pending recorded cassette
1 fail    "must EITHER succeed OR raise cassette-miss" — loud signal that interactive
          isn't provable in this environment without recording. THIS IS INTENDED.
```

The single failing test is the deliverable's truth surface: it goes green only when a real recorded cassette is committed OR the cassette pipeline produces a recognizable miss error. Either outcome proves the wiring; the current red state proves the absence of a fixture.

### What's still open (carried forward, not blockers for accepting infrastructure)
- **Real Anthropic recording** (requires credentials this autonomous run did not have)
- Wave 2 P1: WS backpressure on `rpc_stderr`
- Wave 2 P2: stderr secret-scrub denylist
- Wave 2 P2: warmup `setTimeout` cancellation in `WebSessionHub#removeRecord`

## Revised verdict
**APPROVE-INFRASTRUCTURE / RED-ON-PROOF**

The cassette + observability infrastructure is approved. The interactive proof is intentionally red until a real cassette is recorded; the loud failure is the correct contract.
