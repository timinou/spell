# PLAN-295: Fix better-ccflare 404 and auth fallback

## Context

PLAN-293 implemented a better-ccflare provider. Two bugs discovered in first live test:

1. **Double /v1/ path (404):** streamBetterCcflare constructs `baseURL: \`${baseUrl}/v1\``, but the Anthropic SDK internally prefixes routes with `/v1/`. Result: `http://localhost:8080/v1/v1/messages` → better-ccflare returns 404. Confirmed via better-ccflare's own request log showing `"path": "/v1/v1/messages"`.
2. **Auth fallback missing:** serviceProviderMap only resolves `ANTHROPIC_AUTH_TOKEN`. When unset, no auth header is sent. better-ccflare instances with API keys configured reject unauthenticated requests with "x-api-key header is required". Need fallback to `ANTHROPIC_API_KEY` so users' existing Anthropic keys work.

## Org Items

- [[id:BUG-330-fix-better-ccflare-double-v1-path-causin]] — Fix double /v1/ path
- [[id:BUG-331-add-anthropic-api-key-fallback-for-bette]] — Add ANTHROPIC_API_KEY fallback

## Verification

1. `bun check:ts` passes
2. `bun test packages/ai/test/better-ccflare-provider.test.ts` passes (existing 5 + new fallback test)
3. `bun test packages/ai/test/better-ccflare-stream.test.ts` passes (existing 12 + new baseURL test)
4. `bun test packages/ai/test/better-ccflare-models.test.ts` passes (6, no change)
5. Manual: curl through better-ccflare shows `/v1/messages` (not `/v1/v1/messages`)
6. Manual: when `ANTHROPIC_AUTH_TOKEN` unset and `ANTHROPIC_API_KEY` set, request includes `x-api-key`

## Execution Manifest

### wave-1 (parallel)
- `BUG-330-fix-better-ccflare-double-v1-path-causin::fix-baseurl` — Fix baseURL in streamBetterCcflare
- `BUG-331-add-anthropic-api-key-fallback-for-bette::update-service-map` — Update serviceProviderMap

### wave-2 (parallel, depends on wave-1)
- `BUG-330-fix-better-ccflare-double-v1-path-causin::update-tests` — Update stream tests
- `BUG-331-add-anthropic-api-key-fallback-for-bette::update-provider-tests` — Update provider tests
- `BUG-331-add-anthropic-api-key-fallback-for-bette::update-stream-tests` — Update stream tests

### Bug 1: Double /v1/ path

**File:** `packages/ai/src/providers/better-ccflare.ts`

Change line 154:
```typescript
// FROM:
baseURL: `${baseUrl}/v1`,
// TO:
baseURL: baseUrl,
```

The Anthropic SDK handles `/v1/` prefixing internally. `streamAnthropic` passes `baseURL` without suffix (line 1042 of anthropic.ts: `baseURL: baseUrl`). Adding `/v1` creates double prefix: `http://localhost:8080/v1/v1/messages`.

Also update line 171 (rawRequestDump URL — informational only):
```typescript
// FROM:
url: `${baseUrl}/v1/messages`,
// TO:
url: `${baseUrl}/messages`,
```

**Test:** Add test to `packages/ai/test/better-ccflare-stream.test.ts` verifying baseURL construction is correct (no `/v1` suffix in the base URL passed to the client).

### Bug 2: Auth fallback

**File:** `packages/ai/src/stream.ts`

Change the serviceProviderMap entry (currently ~line 131):
```typescript
// FROM:
"better-ccflare": () => $pickenv("ANTHROPIC_AUTH_TOKEN"),
// TO:
"better-ccflare": () => $pickenv("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"),
```

Priority: `ANTHROPIC_AUTH_TOKEN` (btr- key) > `ANTHROPIC_API_KEY` (standard Anthropic key) > `""` (keyless mode).

No changes needed to `buildBetterCcflareHeaders` — it already correctly handles:
- apiKey set + not OAuth → `x-api-key: <key>`
- apiKey empty → no header (keyless mode for instances without API keys)

**Tests:**
- `packages/ai/test/better-ccflare-provider.test.ts`: Add test verifying `getEnvApiKey("better-ccflare")` falls back to `ANTHROPIC_API_KEY` when `ANTHROPIC_AUTH_TOKEN` unset
- `packages/ai/test/better-ccflare-stream.test.ts`: Existing tests still valid

## Key Finding

better-ccflare does NOT support "OAuth passthrough" mode (no auth header → proxy uses own OAuth). Per docs, API auth is OPTIONAL — when no API keys are generated, the proxy is wide open. When keys exist, `x-api-key: btr-xxx` is required. No OAuth/Bearer auth path exists for the proxy endpoint. The OAuth token detection in `buildBetterCcflareHeaders` (isAnthropicOAuthToken) is harmless but unnecessary — better-ccflare just validates `x-api-key` header regardless of key format.
