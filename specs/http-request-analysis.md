# HTTP Request Analysis: better-ccflare vs standard anthropic

## Executive Summary

The `better-ccflare` stream function and the standard `anthropic` stream function construct HTTP requests to different endpoints due to baseURL configuration differences. The better-ccflare provider has a **critical baseURL bug** that results in a double `/v1/` path segment when forwarding requests to Anthropic.

## Root Cause: Double /v1/ Issue

### The Bug

**Location 1: better-ccflare.ts line 154**
```typescript
const client = new Anthropic({
    apiKey: apiKey || "dummy",
    baseURL: `${baseUrl}/v1`,  // <-- Already appends /v1
    maxRetries: 4,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
});
```

**Location 2: better-ccflare.ts line 171**
```typescript
rawRequestDump = {
    provider: model.provider,
    api: output.api,
    model: model.id,
    method: "POST",
    url: `${baseUrl}/v1/messages`,  // <-- Appends /v1/messages again
    body: params,
};
```

### What Happens

When the Anthropic SDK client is initialized with `baseURL: "${baseUrl}/v1"`, and then the stream function constructs a URL as `${baseUrl}/v1/messages`, the resulting request becomes:

**Expected (correct):**
- `https://api.anthropic.com/v1/messages`
- or `http://localhost:8080/v1/messages` (for better-ccflare proxy)

**Actual (buggy):**
- `http://localhost:8080/v1/v1/messages` (double /v1/)

### Why It Works in Anthropic Provider

The standard `anthropic.ts` handles this correctly:

**anthropic.ts line 636:**
```typescript
const baseUrl = resolveAnthropicBaseUrl(model, apiKey) ?? "https://api.anthropic.com";
```

**anthropic.ts line 658:**
```typescript
rawRequestDump = {
    provider: model.provider,
    api: output.api,
    model: model.id,
    method: "POST",
    url: `${baseUrl}/v1/messages`,  // rawRequestDump uses full URL
    body: params,
};
```

**anthropic.ts line 638-647:** The client creation delegates to `buildAnthropicClientOptions()` which returns a properly configured SDK client:

```typescript
const { client, isOAuthToken } = createClient(model, {
    model,
    apiKey,
    extraBetas: normalizeExtraBetas(options?.betas),
    stream: true,
    interleavedThinking: options?.interleavedThinking ?? true,
    headers: options?.headers,
    dynamicHeaders: copilotDynamicHeaders?.headers,
    isOAuth: options?.isOAuth,
});
```

When SDK client is created via `buildAnthropicClientOptions()` (anthropic.ts line 1068):
```typescript
return {
    isOAuthToken: oauthToken,
    apiKey: oauthToken ? null : apiKey,
    authToken: oauthToken ? apiKey : undefined,
    baseURL: baseUrl,  // <-- Just the domain, NO /v1
    maxRetries: 5,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    ...(tlsFetchOptions ? { fetchOptions: tlsFetchOptions } : {}),
};
```

The key: `baseURL` is set to just `baseUrl` (e.g., `https://api.anthropic.com` or `http://localhost:8080`), **not** `${baseUrl}/v1`.

The SDK automatically appends `/v1/messages` when making the request.

## HTTP Request Comparison

### Standard Anthropic Provider

```
POST https://api.anthropic.com/v1/messages
Headers:
  Accept: text/event-stream
  Accept-Encoding: gzip, deflate, br, zstd
  Connection: keep-alive
  Content-Type: application/json
  Anthropic-Version: 2023-06-01
  Anthropic-Dangerous-Direct-Browser-Access: true
  Anthropic-Beta: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,...
  User-Agent: claude-cli/2.1.63 (external, cli)
  X-App: cli
  X-Api-Key: <api-key> OR Authorization: Bearer <oauth-token>
  [X-Stainless-* headers]

Body:
  {
    "model": "claude-opus-4-7",
    "messages": [...],
    "max_tokens": ...,
    "system": [...],
    "tools": [...],
    "thinking": { "type": "adaptive" },
    "output_config": { "effort": ... },
    ...
  }
```

### Better-CCFlare Provider (BUGGY)

```
POST http://localhost:8080/v1/v1/messages  <-- WRONG: double /v1/
Headers:
  Accept: text/event-stream
  Accept-Encoding: gzip, deflate, br
  Connection: keep-alive
  Content-Type: application/json
  Anthropic-Version: 2023-06-01
  Anthropic-Dangerous-Direct-Browser-Access: true
  Anthropic-Beta: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,...
  User-Agent: claude-cli/2.1.63 (external, cli)
  X-App: cli
  Authorization: Bearer <oauth-token> OR x-api-key: <api-key>
  [X-Stainless-* headers from buildBetterCcflareHeaders]

Body:
  (same as above)
```

## Key Differences in Header Construction

### buildBetterCcflareHeaders (better-ccflare.ts lines 60-105)
- Does NOT enforce header conflicts the same way as buildAnthropicHeaders
- Does NOT include zstd in Accept-Encoding
- Auth logic is simpler: Bearer for OAuth, x-api-key for API key
- Doesn't validate against isAnthropicApiBaseUrl like buildAnthropicHeaders does

### buildAnthropicHeaders (anthropic.ts lines 126-177)
- Enforces that model-specific headers cannot override critical headers
- Includes `zstd` in Accept-Encoding
- Auth logic accounts for OAuth tokens on non-Anthropic baseURLs:
  ```typescript
  if (oauthToken && options.baseUrl && !isAnthropicApiBaseUrl(options.baseUrl)) {
      headers.Authorization = `Bearer ${options.apiKey}`;
  } else {
      headers["X-Api-Key"] = options.apiKey;
  }
  ```

## Impact on Error Handling

When better-ccflare sends a request to `http://localhost:8080/v1/v1/messages`:

1. **400 Bad Request** - The proxy receives an invalid path
2. **Anthropic SDK catches this** - The SDK's internal HTTP client gets a 400 response
3. **Error saved to http-400-requests** - The error dump shows the malformed URL in action
4. **User sees request failed** - No useful diagnostic of the actual problem

## Fix Required

**File: packages/ai/src/providers/better-ccflare.ts**

**Line 154 - Change:**
```typescript
// Before (WRONG):
baseURL: `${baseUrl}/v1`,

// After (CORRECT):
baseURL: baseUrl,
```

This makes better-ccflare behave identically to the standard anthropic provider, where the SDK client is initialized with just the domain, and the SDK appends `/v1/messages` automatically.

## Related Code Paths

### streamBetterCcflare
- File: `packages/ai/src/providers/better-ccflare.ts:107-449`
- Lines 139-158: Client creation with baseURL bug
- Lines 160-173: buildParams call and rawRequestDump creation
- Lines 193: `client.messages.stream()` call (SDK handles actual request)

### streamAnthropic  
- File: `packages/ai/src/providers/anthropic.ts:594-900+`
- Lines 636: baseUrl resolution (NO /v1 appended)
- Lines 638-647: createClient() call (delegates to buildAnthropicClientOptions)
- Lines 648-660: buildParams call and rawRequestDump creation
- Lines 682: `client.messages.stream()` call (SDK handles actual request)

### createClient / buildAnthropicClientOptions
- File: `packages/ai/src/providers/anthropic.ts:1006-1083`
- Responsible for building SDK client options correctly
- Returns `baseURL: baseUrl` (without /v1)
- This is NOT called by better-ccflare

## Verification Points

1. **baseURL initialization:** better-ccflare appends `/v1`, standard doesn't
2. **Header construction:** Different functions with slightly different logic
3. **Model parameter passing:** Both use buildParams correctly
4. **SDK interaction:** Both call `client.messages.stream({ ...params, stream: true })`
5. **Error manifests as:** 400 Bad Request with doubled path in request body dump

## Anthropic API Specification

The Anthropic SDK expects:
- `baseURL`: Domain only (e.g., `https://api.anthropic.com`)
- SDK appends: `/v1/messages` automatically
- Final URL constructed by SDK: `${baseURL}/v1/messages`

**Better-ccflare violates this by setting:**
- `baseURL: ${baseUrl}/v1`
- This causes SDK to construct: `${baseUrl}/v1/v1/messages` ❌

## Test Case

For a better-ccflare request with baseUrl = `http://localhost:8080`:

**Current (buggy):**
- Client baseURL: `http://localhost:8080/v1`
- SDK constructs: `http://localhost:8080/v1/v1/messages`
- Result: 400 Bad Request from proxy

**Fixed:**
- Client baseURL: `http://localhost:8080`
- SDK constructs: `http://localhost:8080/v1/messages`
- Result: 200 OK (proper forwarding to Anthropic)
