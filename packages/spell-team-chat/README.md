# Spell Team Chat

A Svelte 5 + Vite SPA that turns a `spell-server` instance into a multiplayer chat workspace for Spell agents.

## What it does

- **Lists every running spell session** registered against `~/.spell/server.sock` (TUI sessions show up automatically; spawned ones too).
- **Per-session chat pane** — subscribes to the session's RPC event stream and renders user prompts, assistant replies (with live `message_update` streaming), tool starts/ends, blocking-event prompts (plan approvals, asks, hook selectors), and artifact previews.
- **Spawn sessions in any folder** — Cmd-N opens a dialog: enter an absolute `cwd`, optional initial prompt, optional template. Routes to the WS `spawn` message.
- **Artifact previews inline** — agent output files (images, text) get a signed-URL preview directly in the chat log.
- **External sessions are read-only for now** — you see their event log live, but prompt injection requires a new socket message (see "Next" below).

## Quick start

```bash
# 1. Build the SPA
bun --cwd packages/spell-team-chat run build

# 2. Configure a spell-server (one-time, ~/.spell or any project dir):
#    .spell/server.kdl must declare http port + auth + a web token
#    .spell/autonomy.kdl must declare at least a manifest name+version.

# 3. Launch
bun packages/spell-team-chat/bin/spell-team-chat.ts --config-dir ~/.spell
# or, after `bun link`:
spell-team-chat --config-dir ~/.spell

# 4. Open the printed URL (default http://localhost:8787/web/) and paste the
#    bearer token from your .spell/server.kdl `web { token … "secret" }` block.
```

## Architecture

```
┌─────────────────────────────────────┐
│  Browser (Svelte 5 SPA)             │
│  • Login (token → localStorage)     │
│  • Session list (live via WS)       │
│  • Chat pane (bubbles + streaming)  │
│  • Spawn dialog (cwd + prompt)      │
└────────────────┬────────────────────┘
                 │ /web/ws (bearer token via ?token=)
                 │ /web/api/sessions (Bearer header)
                 │ /web/artifacts/<id>/<agent>/<tool>/<file>?sig=…
                 ▼
┌─────────────────────────────────────┐
│  @oh-my-pi/spell-server             │
│  • WebSocket protocol (existing)    │
│  • Session registry (~/.spell/...)  │
│  • Artifact router + signed URLs    │
│  • SPA assets via SPELL_WEB_DIST    │
└────────────────┬────────────────────┘
                 │
                 ▼
        TUI sessions / spawned RPC sessions
```

## How the SPA is served

`spell-team-chat` sets `SPELL_WEB_DIST=$package/dist` and execs
`@oh-my-pi/spell-server`. The server's `resolveSpellWebDist()` honors that env
var ahead of the bundled React dashboard.

## File map

```
src/
  App.svelte                 root: auth gate + WS lifecycle
  app.css                    design tokens (sakya-derived, Spell purple primary)
  main.ts                    Svelte mount
  lib/
    protocol.ts              WsClient/Server message + SessionSummary mirrors
    ws.ts                    reconnecting WS client w/ correlation-id requests
    stores.svelte.ts         AppStore (runes) + ToastStore
    api.ts                   REST helpers + tokenStore (localStorage)
    time.ts                  formatRelative / formatClock
  components/
    Shell.svelte             3-pane grid + ⌘N + theme toggle
    Login.svelte
    SessionList.svelte / SessionItem.svelte
    ChatPane.svelte          event log → bubbles, auto-scroll
    Bubble.svelte            user / assistant / tool / blocking / artifact / error
    InputBar.svelte          textarea + ⌘⏎ send
    SpawnDialog.svelte       cwd + initialPrompt + template select
    ArtifactInline.svelte    signed-URL <img> / open link
    Toast.svelte
bin/
  spell-team-chat.ts         launcher: sets SPELL_WEB_DIST and execs spell-server
```

## Next (deliberately out of MVP)

1. **Prompt-injection to external TUI sessions** — today external sessions stream events out but accept no input. Needs a new socket message (e.g. `prompt_external`) on the spell-server side and a TUI handler that pipes it to `submitMidSessionInput()`.
2. **Cross-server peer discovery** via `pi-edit-broker` for multi-machine scenarios.
3. **Multi-identity** — each user picks a name when entering token; show authorship on user bubbles.
4. **Collaborative plan editing** — Loro CRDT on org PLAN bodies (sakya's `loro-crdt` pattern).



## Testing

Two tiers, both on `bun:test` so the monorepo `bun run --workspaces test` picks them up:

### Tier 1 — Pure reducers (`test/unit/`)

`stores.svelte.ts` delegates to pure functions in `src/lib/reducers.ts`
(`applyRpcEvent`, `commitPending`, `pushUserBubble`, …) so the full
SessionState lifecycle is testable without runes or a DOM. ~30ms for 16 tests.

```bash
bun run test:unit
```

### Tier 3 — Full-stack E2E (`test/e2e/`)

`test/helpers/test-server.ts` spawns a real `spell-server` subprocess with
our SPA mounted via `SPELL_WEB_DIST`, picks a free port, writes a
disposable `.spell/` config, and waits for `/web/` to come up. The test
drives the SPA with a real Chromium via Playwright (as a library —
single test runner stays `bun:test`).

Mirrors the `TestSocketClient` pattern in
`packages/spell-server/test/socket/integration.test.ts`: own the
subsystem inside the test, drive via a real client.

```bash
bun run test:e2e
```

Covers: login form, WS auth, raw-cwd spawn, user-bubble reactivity (the
regression that needed three rebuilds to catch by hand), theme toggle,
REST `/web/api/sessions` shape. ~35s for 6 tests.

### Tier 2 (deferred) — Component-isolated tests

Not scaffolded yet. The world-class option is **vitest 4 + `vitest-browser-svelte`** with Playwright Chromium. Setup cost: a separate vitest config + ~150 MB browser binary already installed for Tier 3. Add when component-level coverage gaps appear that Tier 3 can\'t catch cheaply.

### Why not Bun + happy-dom?

Bun\'s official Svelte testing guide is Svelte 4 only and uses a custom
loader + happy-dom. As of May 2026, Svelte 5 + Bun + happy-dom has
known runes bugs. Tier 3 covers the same surface in a real browser
without the workarounds.

## Recording cassettes

The Tier-3 E2E suite uses HTTP cassettes (`packages/ai/src/cassette/`) to make LLM-driven flows deterministic. When the headline `test/e2e/interactive.test.ts` runs in replay mode, the Anthropic SDK's fetch is intercepted and served from `packages/spell-team-chat/test/cassettes/`.

### When to record

- Adding a new e2e test that prompts the agent.
- The provider's wire shape changed (new SDK version, new headers in request).
- Cassette drift (fingerprint mismatch error in test output — see below).

### How to record

1. Export real Anthropic credentials in your shell:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```
2. Run the test suite in record mode:
   ```bash
   SPELL_CASSETTE_DIR=packages/spell-team-chat/test/cassettes \
   SPELL_CASSETTE_MODE=record \
   bun --cwd packages/spell-team-chat run test:e2e
   ```
3. Each provider call writes a `<fingerprint>.json` file in the cassette dir.

### Where cassettes live

`packages/spell-team-chat/test/cassettes/<sha256-hex>.json`. Filenames are deterministic — they're the SHA-256 of `method + URL + stable-stringified body`. Two callers issuing the same request bytes produce the same fingerprint, so cassettes are commit-stable.

### Reviewing before commit

Before committing a recorded cassette, **read the JSON**:

- `request.headers.authorization` MUST be `<redacted>` (the redact pass in `packages/ai/src/cassette/redact.ts` handles this automatically — verify it actually fired)
- `request.headers.x-api-key` and `anthropic-api-key` must also be redacted
- `response.headers` for `set-cookie` (we strip these too)
- The request body must NOT contain PII you don't want in version control

If any of the above leaked, **delete the cassette and re-record after fixing redaction.**

### When NOT to commit

Cassettes recorded against accounts with PII, or against responses containing the real user's data, do not belong in git. Mark them with a `.local.json` suffix and add a `.gitignore` rule if you don't want them to round-trip.

### Cassette drift

If an existing test starts failing with:
```
No cassette match for fingerprint=<hex>. Hint: record first with SPELL_CASSETTE_MODE=record.
```

The request body changed since the cassette was recorded. Either:
- Roll back the change that altered the request body, or
- Re-record (with real creds) and commit the new cassette.

## Design DNA

Tokens lifted wholesale from `~/code/personal/sakya/src/app.css`, with two swaps:

- Primary accent: sakya `#3b6fd4` (blue) → Spell `#6b5cd8` (purple)
- Secondary accent: sakya `#6b4fb8` (purple) → Spell `#3b6fd4` (blue, demoted)

Everything else (warm off-white `#faf8f5`, 5-tier text, 6-step spacing, Inter + JetBrains Mono, light/dark via `[data-theme]`, ~28-44px row heights, `BinderItem` left-border-accent active style) carries over.
