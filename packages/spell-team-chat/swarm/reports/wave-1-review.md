# Wave 1 Review — Cassette Infrastructure

Date: 2026-05-15
Reviewer: reviewer agent

## Verdict
PASS_WITH_FOLLOWUPS

Core contracts hold: secrets are redacted before disk write, replay never falls back to the network, fingerprint excludes headers/timestamps, SSE order is preserved, provider wiring defaults to passthrough. Tests (5/5) and `tsgo` are clean. Wave 2 can proceed in parallel with the follow-ups below; none of them block recording the first real Anthropic cassette.

## Findings

### High-severity
- none

### Medium-severity
- `packages/ai/src/providers/anthropic.ts:647-652` — `SPELL_CASSETTE_MODE` is `as`-cast without validation. `cassetteFetch` only special-cases `"passthrough"` and `"replay"`; any other value (e.g. typo `"replays"`, `"REPLAY"`, empty string after splitting CI env) silently falls into the **record** branch and hits the real Anthropic API. This breaks the "replay must not make network calls" contract whenever the env value is mistyped. Suggest validating to the enum and defaulting unknown values to `"passthrough"` (or throwing), and lowercasing.
- `packages/ai/src/cassette/index.ts:111-156` — the record-mode persistence is a fire-and-forget IIFE: no `.catch`, no caller-visible handle, no awaited completion. Failures from `saveCassette` become unhandled rejections (fatal under `--unhandled-rejections=strict`). Short-lived processes / tests have to busy-wait (the unit tests already do `setTimeout(50)`) and any process exit between stream end and `Bun.write` resolving drops the cassette. Suggest tracking the in-flight writes (e.g. expose `flush()` or wait inside `cassetteFetch`'s returned Response close hook) and at least `.catch(err => console.error(...))` so failures surface.
- `packages/ai/src/cassette/store.ts:5-11` — `loadCassette` swallows every error in one `catch {}` and returns `null`. A corrupt JSON cassette therefore presents as a miss with the misleading `Hint: record first` message, which in CI would tempt the operator to re-record and overwrite. Distinguish ENOENT (real miss) from `SyntaxError` / `EACCES` (raise with file path).

### Low-severity
- `packages/ai/src/cassette/sse.ts:11-13` — replay delay uses `Math.min(event.deltaMs, 10)` (cap ✓) but no `Math.max(..., 0)` guard; a negative `deltaMs` written by a future recorder bug would skip `setTimeout` entirely (harmless) or schedule weirdly. Trivially defensive: `Math.max(0, Math.min(event.deltaMs, 10))`.
- `packages/ai/src/cassette/index.ts:120-130` — SSE recording calls `decoder.decode(value, { stream: true })` per chunk but never flushes (`decoder.decode()`/`decode(empty, {stream:false})`) on `done`. For Anthropic SSE this is ASCII-only in practice, but a UTF-8 chunk boundary split mid-codepoint would drop the trailing bytes from the cassette. Add a final flush after the loop.
- `packages/ai/src/cassette/match.ts:30` — URL normalization only strips trailing slashes; query parameter ordering, default ports and fragments are not normalized. Not currently a problem because the Anthropic SDK uses a fixed `/v1/messages` URL, but worth a comment so future providers don't get burned.
- `packages/ai/src/providers/anthropic.ts:647-648` — env access uses raw `process.env.SPELL_CASSETTE_*` instead of the package's `$env` helper used everywhere else in this file (e.g. `$env.ANTHROPIC_BASE_URL`). Cosmetic inconsistency.
- `packages/ai/test/cassette/cassette.test.ts:103-141` — fingerprint stability test covers key reordering and value diff, but **does not** assert header independence (the explicit contract). Add a third request differing only in `authorization`/`user-agent` and assert equal fingerprint. Also missing: a test that response `set-cookie` is redacted, and a test that SSE replay caps `deltaMs` at 10 ms (e.g. recorded delta of 1000 ms must replay in ≤ ~50 ms).
- `packages/ai/src/cassette/redact.ts:1-9` — denylist hits every requested key (case-insensitive ✓) and adds `openai-organization` and `x-goog-api-key` proactively. Consider adding `proxy-authorization` and `x-anthropic-billing-header` (the latter is generated per-request in `anthropic.ts` and embeds a sha256-derived value — not strictly a secret, but it leaks build-hash entropy into shared fixtures).

## Required fixes before Wave 2
- none (verdict is PASS_WITH_FOLLOWUPS)

## Suggested follow-ups (non-blocking)
- Validate `SPELL_CASSETTE_MODE` and reject unknown values (medium).
- Track in-flight cassette writes; expose `flush()` and attach `.catch` to the persistence IIFE (medium).
- Differentiate ENOENT from parse/permission errors in `loadCassette` (medium).
- Final-flush the SSE TextDecoder; clamp `deltaMs` to ≥ 0 in `replaySse` (low).
- Strengthen tests: header-independent fingerprint, response-header redaction, SSE delay cap (low).
- Switch the two new env reads to `$env.*` for parity with the rest of `anthropic.ts` (low).
- Consider adding `proxy-authorization` and `x-anthropic-billing-header` to the redact denylist (low).

## Test evidence
- `bun --cwd packages/ai test test/cassette`: **5 pass / 0 fail** (13 expect() calls, 199 ms).
- `bun --cwd packages/ai run check`: **clean** (only `$ tsgo -p tsconfig.json`, no diagnostics).

## Surface stats
- Files added: 7 (5 source under `packages/ai/src/cassette/`, 1 unit test, 1 hand-crafted fixture).
- Lines added: ~276 source + ~142 test + ~47 fixture = **~465 lines**; `packages/ai/src/providers/anthropic.ts` modified +10/−1.
- New runtime deps: **no** (uses `node:crypto`, `node:fs/promises`, `Bun.file`/`Bun.write` only).
