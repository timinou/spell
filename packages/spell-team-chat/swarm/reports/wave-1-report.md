# Wave 1 Report — Cassette Infrastructure

Date: 2026-05-15
Wave: 1 of 3
Status: COMPLETE (gated by Review 1: PASS_WITH_FOLLOWUPS)

## Delivered
- `packages/ai/src/cassette/` — 5-file module: index, store, match, sse, redact
- `packages/ai/test/cassette/cassette.test.ts` — 5 tests, round-trip + redaction + miss + fingerprint stability + SSE chunk-order, all passing in ~200ms
- `packages/spell-team-chat/test/cassettes/e28762b6….json` — hand-crafted Anthropic SSE fixture, fingerprint computed via cassette-core's `defaultFingerprint`
- `packages/ai/src/providers/anthropic.ts` — env-gated cassette wrap on the SDK fetch injection, defaults to passthrough

## Test evidence
- `bun --cwd packages/ai run check` → clean
- `bun --cwd packages/ai test test/cassette` → 5 pass / 0 fail (13 expects, 200ms)

## Deviations from manifest
1. `CassetteOptions.fingerprint` signature widened from `(req) => string` to `(req) => string | Promise<string>` — necessary because the body is a stream and async reads are unavoidable.
2. `as` casts at provider wire site — Bun's `BunFetchRequestInit` and Anthropic SDK's fetch type don't compose cleanly without coercion. Comment in the diff explains why.

## Post-review patches applied
- Fixed P1 (mode validation): `packages/ai/src/providers/anthropic.ts:647-652` — `SPELL_CASSETTE_MODE` now validates against the enum and defaults unknown/typo values to `passthrough` instead of silently falling through to `record`. This closes the contract-critical determinism hole the reviewer flagged.

## Carried forward as follow-ups (not blocking)
- P1 fire-and-forget save → add `flush()` + `.catch()` to record-mode persistence
- P2 `loadCassette` swallows all errors → distinguish ENOENT from SyntaxError/EACCES
- P3 SSE decoder final-flush; clamp `deltaMs` ≥ 0
- P3 strengthen tests: header-independent fingerprint, response-header redaction, SSE delay cap
- P3 switch env reads to `$env.*` helper

## Gate to Wave 2
✅ All P1 contract-critical findings resolved or accepted. Wave 2 may proceed.
