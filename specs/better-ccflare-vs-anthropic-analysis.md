# HTTP Request Construction Comparison: better-ccflare vs anthropic

## Overview
Both `streamBetterCcflare` and `streamAnthropic` are stream functions for the Anthropic SDK using the same `anthropic-messages` API type. However, they differ significantly in **client instantiation** and **header construction**, which directly impacts the HTTP requests sent upstream.

---

## 1. CLIENT INSTANTIATION

### better-ccflare (lines 107-158)
```typescript
const client = new Anthropic({
  apiKey: apiKey || "dummy",  // SDK requires non-empty string
  baseURL: `${baseUrl}/v1`,
  maxRetries: 4,
  dangerouslyAllowBrowser: true,
  defaultHeaders,  // from buildBetterCcflareHeaders()
});
```

**Key traits:**
- Appends `/v1` to baseURL immediately: `baseURL: ${baseUrl}/v1`
- maxRetries = 4
- Uses **buildBetterCcflareHeaders()** for defaultHeaders

### anthropic (lines 635-647)
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

**Key traits:**
- Delegates client creation to `createClient()` function
- Passes `interleavedThinking` as explicit option (default: `true`)
- Handles GitHub Copilot dynamic headers separately
- Client creation is transparent to caller

---

## 2. createClient() FUNCTION (line 1076-1083)

```typescript
function createClient(
  model: Model<"anthropic-messages">,
  args: AnthropicClientOptionsArgs,
): { client: Anthropic; isOAuthToken: boolean } {
  const { isOAuthToken: oauthToken, ...clientOptions } = buildAnthropicClientOptions({ ...args, model });
  const client = new Anthropic(clientOptions);
  return { client, isOAuthToken: oauthToken };
}
```

Delegates to `buildAnthropicClientOptions()` → returns full clientOptions object.

---

## 3. buildAnthropicClientOptions() (line 1006-1074)

Builds client options **conditionally** based on provider:

### GitHub Copilot (lines 1021-1047)
```typescript
if (model.provider === "github-copilot") {
  const betaFeatures = [...extraBetas];
  if (interleavedThinking) {
    betaFeatures.push("interleaved-thinking-2025-05-14");
  }
  const defaultHeaders = mergeHeaders(
    {
      Accept: stream ? "text/event-stream" : "application/json",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      Authorization: `Bearer ${apiKey}`,
      ...(betaFeatures.length > 0 ? { "anthropic-beta": buildBetaHeader([], betaFeatures) } : {}),
    },
    model.headers,
    dynamicHeaders,
    headers,
  );
  return {
    isOAuthToken: false,
    apiKey: null,
    authToken: apiKey,
    baseURL: baseUrl,
    maxRetries: 5,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    ...(tlsFetchOptions ? { fetchOptions: tlsFetchOptions } : {}),
  };
}
```

**Key traits for GitHub Copilot:**
- baseURL is NOT appended with `/v1` (baseURL passed as-is)
- maxRetries = 5
- Uses `authToken` (not `apiKey`) when constructing Anthropic client
- Manually constructs Authorization header

### Standard Anthropic (lines 1050-1074)
```typescript
const betaFeatures = [...extraBetas];
if (interleavedThinking) {
  betaFeatures.push("interleaved-thinking-2025-05-14");
}
const defaultHeaders = buildAnthropicHeaders({
  apiKey,
  baseUrl,
  isOAuth: oauthToken,
  extraBetas: betaFeatures,
  stream,
  modelHeaders: mergeHeaders(model.headers, foundryCustomHeaders, headers, dynamicHeaders),
});
return {
  isOAuthToken: oauthToken,
  apiKey: oauthToken ? null : apiKey,
  authToken: oauthToken ? apiKey : undefined,
  baseURL: baseUrl,  // NO `/v1` appended
  maxRetries: 5,
  dangerouslyAllowBrowser: true,
  defaultHeaders,
  ...(tlsFetchOptions ? { fetchOptions: tlsFetchOptions } : {}),
};
```

**Key traits:**
- baseURL is NOT appended with `/v1` (baseURL passed as-is)
- maxRetries = 5
- Uses **buildAnthropicHeaders()** for defaultHeaders
- Conditional apiKey vs authToken based on OAuth token type

---

## 4. HEADER CONSTRUCTION COMPARISON

### buildBetterCcflareHeaders() (line 60-105)

```typescript
export function buildBetterCcflareHeaders(options: BetterCcflareHeaderOptions): Record<string, string> {
  const oauthToken = options.isOAuth ?? isAnthropicOAuthToken(options.apiKey);
  const extraBetas = options.extraBetas ?? [];
  const stream = options.stream ?? false;
  const betaHeader = buildBetaHeader(claudeCodeBetaDefaults, extraBetas);
  const acceptHeader = stream ? "text/event-stream" : "application/json";
  const incomingUserAgent = getHeaderCaseInsensitive(options.modelHeaders, "User-Agent");
  const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent)
    ? incomingUserAgent
    : `claude-cli/${claudeCodeVersion} (external, cli)`;

  const headers: Record<string, string> = {
    ...claudeCodeHeaders,  // ← Stainless headers
    Accept: acceptHeader,
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Content-Type": "application/json",
    "Anthropic-Version": "2023-06-01",
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    "Anthropic-Beta": betaHeader,
    "User-Agent": userAgent,
    "X-App": "cli",
  };

  // Auth: OAuth passthrough when apiKey is empty/falsy
  if (options.apiKey) {
    if (oauthToken) {
      headers.Authorization = `Bearer ${options.apiKey}`;
    } else {
      headers["x-api-key"] = options.apiKey;
    }
  }
  // else: NO auth header → OAuth passthrough mode

  // Apply model-specific headers, respecting enforced keys
  const enforcedHeaderKeys = new Set(Object.keys(headers).map(key => key.toLowerCase()));
  if (options.modelHeaders) {
    for (const [key, value] of Object.entries(options.modelHeaders)) {
      if (!enforcedHeaderKeys.has(key.toLowerCase())) {
        headers[key] = value;
      }
    }
  }

  return headers;
}
```

### buildAnthropicHeaders() (line 126-178)

```typescript
export function buildAnthropicHeaders(options: AnthropicHeaderOptions): Record<string, string> {
  const oauthToken = options.isOAuth ?? isAnthropicOAuthToken(options.apiKey);
  const extraBetas = options.extraBetas ?? [];
  const stream = options.stream ?? false;
  const betaHeader = buildBetaHeader(claudeCodeBetaDefaults, extraBetas);
  const acceptHeader = stream ? "text/event-stream" : "application/json";
  const incomingUserAgent = getHeaderCaseInsensitive(options.modelHeaders, "User-Agent");
  const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent)
    ? incomingUserAgent
    : `claude-cli/${claudeCodeVersion} (external, cli)`;
  const enforcedHeaderKeys = new Set(
    [
      ...Object.keys(claudeCodeHeaders),
      "Accept",
      "Accept-Encoding",
      "Connection",
      "Content-Type",
      "Anthropic-Version",
      "Anthropic-Dangerous-Direct-Browser-Access",
      "Anthropic-Beta",
      "User-Agent",
      "X-App",
      "Authorization",
      "X-Api-Key",  // ← Case-insensitive key
    ].map(key => key.toLowerCase()),
  );
  const modelHeaders = Object.fromEntries(
    Object.entries(options.modelHeaders ?? {}).filter(([key]) => !enforcedHeaderKeys.has(key.toLowerCase())),
  );
  const headers: Record<string, string> = {
    ...modelHeaders,
    ...claudeCodeHeaders,  // ← Stainless headers
    Accept: acceptHeader,
    "Accept-Encoding": "gzip, deflate, br, zstd",  // ← INCLUDES zstd
    Connection: "keep-alive",
    "Content-Type": "application/json",
    "Anthropic-Version": "2023-06-01",
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    "Anthropic-Beta": betaHeader,
    "User-Agent": userAgent,
    "X-App": "cli",
  };

  // Localhost proxies: send X-Api-Key for OAuth passthrough (proxy detects Claude CLI UA)
  // OAuth tokens to non-Anthropic URLs get Bearer; standard gets x-api-key
  if (oauthToken && options.baseUrl && !isAnthropicApiBaseUrl(options.baseUrl)) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  } else {
    headers["X-Api-Key"] = options.apiKey;  // ← Always set (capitalized)
  }

  return headers;
}
```

### Header Differences Summary

| Aspect | better-ccflare | anthropic |
|--------|---|---|
| **Accept-Encoding** | `gzip, deflate, br` | `gzip, deflate, br, zstd` |
| **X-Api-Key handling** | `x-api-key` (lowercase) when no OAuth | Always set, capitalized `X-Api-Key` |
| **OAuth passthrough** | No auth header when apiKey falsy | Always sets X-Api-Key or Bearer |
| **baseUrl check in auth** | None | Checks if baseUrl is non-Anthropic (for Bearer auth) |
| **Model header merging order** | Headers applied after enforced set | Model headers filtered first, then applied |

---

## 5. PARAMS CONSTRUCTION

Both use **the same `buildParams()` function** (line 1347-1437), which handles:
- Message conversion (`convertAnthropicMessages`)
- Tool conversion (`convertTools`)
- Thinking mode resolution (uses `isAnthropicAdaptiveOnlyModel()`)
- System block building
- Cache control

### Critical difference in buildParams()

**Line 1375-1399 in buildParams():**
```typescript
const adaptiveOnlyThinking = isAnthropicAdaptiveOnlyModel(model);
const resolvedOptions = options ?? {};
if ((resolvedOptions.thinkingEnabled || adaptiveOnlyThinking) && model.reasoning) {
  const mode = model.thinking?.mode;
  const requestedEffort = adaptiveOnlyThinking ? undefined : resolvedOptions.reasoning;
  const effort = adaptiveOnlyThinking
    ? undefined
    : (resolvedOptions.effort ??
        (requestedEffort ? mapEffortToAnthropicAdaptiveEffort(model, requestedEffort) : undefined));

  if (mode === "anthropic-adaptive") {
    params.thinking = { type: "adaptive" };
    if (effort) {
      params.output_config = { effort };
    }
  } else {
    params.thinking = {
      type: "enabled",
      budget_tokens: resolvedOptions.thinkingBudgetTokens || 1024,
    };
    if (mode === "anthropic-budget-effort" && effort) {
      params.output_config = { effort };
    }
  }
}
```

**Model check: `isAnthropicAdaptiveOnlyModel()` (line 122-124)**
```typescript
export function isAnthropicAdaptiveOnlyModel(model: Model<"anthropic-messages">): boolean {
  return model.id === "claude-opus-4-7";
}
```

- **claude-opus-4-7** is treated as "adaptive-only": effort and requestedEffort become undefined
- Both functions call buildParams the **same way**, so both should handle claude-opus-4-7 identically
- ✓ No difference in params construction between the two

---

## 6. BASE URL RESOLUTION

### better-ccflare in stream function (line 139)
```typescript
const baseUrl = resolveAnthropicBaseUrl(model, apiKey) ?? "http://localhost:8080";
```

Default: `http://localhost:8080`

### anthropic in stream function (line 636)
```typescript
const baseUrl = resolveAnthropicBaseUrl(model, apiKey) ?? "https://api.anthropic.com";
```

Default: `https://api.anthropic.com`

### resolveAnthropicBaseUrl() logic (line 431-459)

For `better-ccflare` (lines 450-456):
```typescript
if (model.provider === "better-ccflare") {
  const modelBaseUrl = normalizeBaseUrl(model.baseUrl);
  if (modelBaseUrl) return modelBaseUrl;
  const envBaseUrl = normalizeBaseUrl($env.ANTHROPIC_BASE_URL);
  if (envBaseUrl) return envBaseUrl;
  return "http://localhost:8080";  // ← Default
}
```

For `anthropic` (lines 444-449):
```typescript
if (model.provider === "anthropic") {
  // Env ANTHROPIC_BASE_URL is fallback when no KDL base-url
  const envBaseUrl = normalizeBaseUrl($env.ANTHROPIC_BASE_URL);
  if (envBaseUrl) return envBaseUrl;
  return "https://api.anthropic.com";  // ← Default
}
```

---

## 7. URL PATH CONSTRUCTION IN REQUESTS

### better-ccflare (line 171)
```typescript
url: `${baseUrl}/v1/messages`,
```

Example: `http://localhost:8080/v1/messages`

### anthropic (line 658)
```typescript
url: `${baseUrl}/v1/messages`,
```

Example: `https://api.anthropic.com/v1/messages`

---

## 8. ACTUAL HTTP CLIENT URL CONSTRUCTION

The **critical difference** is in the Anthropic SDK's client constructor behavior:

### better-ccflare client (line 154)
```typescript
baseURL: `${baseUrl}/v1`,
```

Then the SDK's `messages.stream()` call appends the path, resulting in:
- **Request URL: `${baseUrl}/v1 + /messages` → `http://localhost:8080/v1/messages`**

### anthropic client (from buildAnthropicClientOptions, line 1068)
```typescript
baseURL: baseUrl,
```

Then the SDK's `messages.stream()` call appends the path, resulting in:
- **Request URL: `${baseUrl} + /v1/messages` → `https://api.anthropic.com/v1/messages`**

---

## 9. POTENTIAL DOUBLE /v1/ BUG INVESTIGATION

### Scenario: baseUrl already contains `/v1`

If `resolveAnthropicBaseUrl()` returns `http://localhost:8080/v1`:

**better-ccflare:**
- Client baseURL: `http://localhost:8080/v1/v1`
- SDK appends `/messages`: `http://localhost:8080/v1/v1/messages` ❌ DOUBLE /v1/!

**anthropic:**
- Client baseURL: `http://localhost:8080/v1`
- SDK appends `/v1/messages`: `http://localhost:8080/v1/v1/messages` ❌ DOUBLE /v1/!

### Current safeguard:
`normalizeBaseUrl()` (called in resolveAnthropicBaseUrl) likely removes trailing `/v1` paths before returning. Both functions would be protected if that's implemented.

---

## 10. STREAM CONSTRUCTION DIFFERENCES

Both use **identical stream handling** (lines 188-417 in better-ccflare, 677-909 in anthropic):
- Same idle timeout logic
- Same event parsing
- Same retry mechanism
- Same error handling

**Identical code:**
```typescript
const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal: requestSignal });
```

The only difference is the **client's baseURL**, which is already set before this line.

---

## 11. INTERLEAVEDTHINKING OPTION

### anthropic: explicit handling
```typescript
interleavedThinking: options?.interleavedThinking ?? true,  // Line 643
```

This is passed to `buildAnthropicClientOptions()` → `buildAnthropicHeaders()`.
- Beta header includes `"interleaved-thinking-2025-05-14"` when true

### better-ccflare: NO explicit handling
The `buildBetterCcflareHeaders()` does NOT receive `interleavedThinking` as a parameter.
- Uses `claudeCodeBetaDefaults` which includes `"interleaved-thinking-2025-05-14"`
- **Always enabled**, cannot be disabled via options

---

## SUMMARY OF DIFFERENCES

| Aspect | better-ccflare | anthropic | Impact |
|--------|---|---|---|
| **Client baseURL** | `${baseUrl}/v1` | `${baseUrl}` | SDK path appending differs |
| **Default base** | `http://localhost:8080` | `https://api.anthropic.com` | Different target server |
| **maxRetries** | 4 | 5 | Better-ccflare retries fewer times |
| **Accept-Encoding** | `gzip, deflate, br` | `gzip, deflate, br, zstd` | Compression negotiation |
| **X-Api-Key capitalization** | `x-api-key` (lowercase) | `X-Api-Key` (capitalized) | Header case sensitivity |
| **OAuth passthrough** | Allows no auth header | Always sets auth header | Authentication mode |
| **interleavedThinking** | Hardcoded (always enabled) | Configurable (default true) | Thinking feature flexibility |
| **Foundry headers** | Not applied | Applied via buildAnthropicClientOptions | Enterprise auth feature |
| **GitHub Copilot support** | Not supported | Native support | Multi-provider support |

---

## LIKELY BUGS FOR MALFORMED REQUESTS

### Bug 1: Double /v1/ if baseUrl includes /v1
**Risk:** If `resolveAnthropicBaseUrl()` returns `...../v1`, better-ccflare appends another `/v1`, creating:
- `http://localhost:8080/v1/v1/messages`

**Anthropic** has same risk, but less likely since it defaults to `https://api.anthropic.com` (no /v1).

### Bug 2: x-api-key vs X-Api-Key case sensitivity
**Risk:** Some proxies or servers may be case-sensitive on headers. 
- better-ccflare sends lowercase `x-api-key`
- anthropic sends capitalized `X-Api-Key`
- Anthropic API documentation uses `x-api-key`, so lowercase is expected.
- **This could cause better-ccflare auth to fail on case-sensitive proxies.**

### Bug 3: Interleavedthinking cannot be disabled in better-ccflare
**Risk:** For models that don't support it, this header may cause validation errors:
- better-ccflare always includes `"interleaved-thinking-2025-05-14"` in betas
- anthropic allows disabling via `interleavedThinking: false` option
- **Claude 3.5 Haiku doesn't support interleaved thinking**, but better-ccflare forces it.

### Bug 4: Missing foundry header handling
**Risk:** If using Foundry-authenticated Anthropic instances:
- anthropic applies foundry headers via `resolveAnthropicCustomHeaders()`
- better-ccflare does NOT apply foundry headers
- **Enterprise deployments may fail to authenticate.**

### Bug 5: OAuth passthrough logic difference
**Risk:** Localhost proxies expecting "OAuth passthrough mode" (no auth header):
- anthropic always sets `X-Api-Key` header
- better-ccflare allows no auth header when apiKey is falsy
- **Better-ccflare is correct for passthrough; anthropic may break passthrough mode.**

---

## RECOMMENDATIONS FOR INVESTIGATION

1. **Verify the default baseUrl for better-ccflare** — Is `http://localhost:8080` the correct local Cloudflare tunnel endpoint?
2. **Check normalizeBaseUrl()** — Does it strip trailing `/v1`? If not, both have the double-/v1/ bug.
3. **Test X-Api-Key case sensitivity** — Verify the Cloudflare endpoint accepts lowercase `x-api-key`.
4. **Test interleaved thinking with Haiku** — Does the forced beta header cause validation errors?
5. **Check OAuth passthrough scenario** — Does the anthropic function's always-set X-Api-Key break localhost proxy auth?
6. **Verify Foundry support** — Is better-ccflare intended for enterprise/foundry use?

