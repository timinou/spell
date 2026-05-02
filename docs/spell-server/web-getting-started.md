# Spell Web Dashboard — Getting Started

A five-minute walkthrough from zero to a running browser dashboard at
`/web/*`, with template-driven session spawning and live artifact previews.

This guide is the practical companion to:

- [`getting-started.md`](./getting-started.md) — base spell-server install,
  `server.kdl` / `autonomy.kdl` / `channels.kdl` fundamentals.
- [`web.md`](./web.md) — full reference: WS protocol, REST routes, signed
  artifact URLs, frontend internals.

## What you get

- Multi-token bearer auth on `/web/*` (no Telegram required).
- A unified session list that shows both server-spawned RPC sessions and any
  external `spell` CLI sessions that opted into the bridge.
- A `Cmd/Ctrl+K` command bar that runs **templates** — schedule-less,
  parameterized presets declared in `autonomy.kdl`. Picking one spawns a fresh
  RPC session and fires its first prompt.
- Per-session tabs: **Stream** (xterm.js over RPC events), **Bash** (live
  command output for spawned sessions), **State** (`get_state` /
  `get_session_stats`), **Artifacts** (downloads + signed-URL embeds for PDFs
  and images).

## Prerequisites

- `spell-server` already runs from `getting-started.md` — i.e. you have
  `.spell/server.kdl` with an `http { port; auth { … } }` block and
  `.spell/autonomy.kdl` with at least one `setup`.
- Bun 1.3.7+.

## 1. Add a `web` block to `server.kdl`

Web tokens are independent of the basic-auth credentials that protect
`/api/*`. Each `token` line maps a human label to a secret (literal or
`env(VAR)` reference).

```kdl
http {
  port 8787
  auth {
    username "admin"
    password "change-me-now" // pragma: allowlist secret
  }
}

web {
  token "alice" "env(SPELL_TOKEN_ALICE)"
  token "bob"   "env(SPELL_TOKEN_BOB, optional)" // dropped silently if unset
}
```

Generate Alice's secret in your shell:

```sh
export SPELL_TOKEN_ALICE=$(openssl rand -hex 24)
```

Without a `web` block, every `/web/*` URL returns 404 — the subsystem is
strictly opt-in.

## 2. Build the SPA bundle

The frontend lives at `packages/spell-server/web/` (Vite + React 19 +
zustand + cmdk + xterm). Build it once per release:

```sh
bun run --cwd=packages/spell-server build:web
```

The server's `loadWebAssets()` helper picks up the resulting `dist/` at
startup and serves it under `/web/` with ETag + immutable cache headers.
If the bundle is missing, `/web/` returns a friendly placeholder reminding
you to run `build:web`.

For frontend-only iteration:

```sh
bun run --cwd=packages/spell-server/web dev
```

This proxies `/web/api`, `/web/artifacts`, and `/web/ws` to a running
`spell-server` on port 8787.

## 3. Start the server and sign in

```sh
bun run packages/spell-server/src/main.ts
```

Open `http://127.0.0.1:8787/web/` in a browser, paste the value of
`$SPELL_TOKEN_ALICE`, and submit. The token is stored in
`localStorage` and sent as `Authorization: Bearer …` on REST/XHR and
as `?token=…` on the WebSocket upgrade.

You will land on an empty session list. The sidebar fills in as soon as
sessions exist.

## 4. Define a template

Templates are the way the dashboard spawns work. Add one to
`autonomy.kdl`:

```kdl
setup "writer" {
  domain "coding"
  mode "default"
  tools {
    allow "read" "grep" "find" "bash"
  }
  sandbox {
    paths-write "out/"
    bash-allow "typst*"
  }
  timeout "10m"
}

template "document" {
  description "Generate a typst PDF report"
  setup "writer"
  mode "rpc"            // only "rpc" supported in v1
  prompt "Generate a typst PDF report on {{topic}}, depth={{depth}}."
  param "topic" type="string" required=#true
  param "depth" type="number"
  artifact-watch ".pdf" ".png"
}
```

Notes:

- `setup` may reference a setup imported via an alias as `<alias>.<name>`.
- `prompt` is rendered with Handlebars at run time. Missing parameters
  expand to the empty string and log a one-shot warning.
- `param` values are coerced from JSON (`string`, `number`, `boolean`,
  list-of-strings).
- `artifact-watch.ext` propagates to the spawned session as
  `watchExtensions` and drives the sidebar's `READY` badge.

Restart the server to pick up the manifest change.

## 5. Run the template from the command bar

1. Press `Cmd+K` (macOS) or `Ctrl+K` (Linux/Windows).
2. Type `document` (or any prefix of a template name or description).
3. Pick the entry — a modal asks for `topic` and `depth`.
4. Submit.

The sidebar adds a card. Its status transitions
`spawning → running → done`. A `READY` badge appears the moment a file
matching `artifact-watch` lands in the session's artifact root.

Behind the scenes:

- `POST /web/api/templates/document/run` invokes `TemplateRunner.runTemplate`,
  which builds spawn options via the shared `setupToSpawnOptions` helper
  (also used by `goal-executor`).
- `WebSessionHub.spawn` creates an RPC client tagged with
  `ownedBy: "alice"` and `templateName: "document"`.
- `hub.send` immediately fires the rendered prompt as the first message.
- Streaming RPC events fan out via the WebSocket as `rpc_event`.

## 6. Inspect a session

Click a card to open the detail view. Hash routing keeps the URL shareable
across reloads.

| Tab | Source | Notes |
|-----|--------|-------|
| Stream | `rpc_event` WS frames | xterm.js renders ANSI bytes produced by the pure `StreamRenderer.ts` translator (unit-tested headlessly). `Cmd+Enter` in the prompt textarea sends a follow-up turn. |
| Bash | `bash` RPC command | Live stdout/stderr; `Ctrl+C` issues `abort_bash`. Hidden for external sessions. |
| State | `get_state` + `get_session_stats` | Pretty-printed JSON snapshot of session memory and counters. |
| Artifacts | `GET /web/api/sessions/:id/artifacts` | One row per file. `Open` mints a short-lived signed URL via `POST /web/api/sessions/:id/artifacts/url`; PDFs render in an iframe, images inline, everything else downloads. |

## 7. Surface external CLI sessions (optional)

Any `spell` CLI session can announce itself to the dashboard so it shows up
alongside spawned ones. Read-only — the daemon never steers external
sessions, only watches their summaries and answers pending blocking
prompts on the user's behalf.

Run the CLI with the bridge env opt-in:

```sh
SPELL_BRIDGE_EVENT_LOG=1 spell
```

Or set the constructor flag on `SessionBridgeClient` programmatically.

The daemon stores a per-session ring buffer (cap 50) of low-fi summary
lines (turn boundaries, tool calls, assistant text — truncated to 256
chars). They surface in the dashboard as `external_event_log` WebSocket
messages and render in the external session's Stream tab.

## 8. Wire it into systemd (optional)

Treat the web subsystem like the rest of the server: foreground process,
restarted by your supervisor of choice. The `getting-started.md` systemd
unit needs no changes — `web {}` activates automatically when the parsed
config carries it. Keep the token-bearing env vars in `EnvironmentFile=`
or your secret manager:

```ini
[Service]
EnvironmentFile=/etc/spell/web-tokens.env
ExecStart=/usr/bin/bun run /srv/my-project/packages/spell-server/src/main.ts
```

`web-tokens.env`:

```sh
SPELL_TOKEN_ALICE=...
SPELL_TOKEN_BOB=...
```

## Verifying end to end

A quick smoke that exercises every layer:

```sh
# REST: lists templates the SPA's command bar will see.
curl -H "Authorization: Bearer $SPELL_TOKEN_ALICE" \
  http://127.0.0.1:8787/web/api/templates

# REST: runs the template (same path the modal uses).
curl -H "Authorization: Bearer $SPELL_TOKEN_ALICE" \
  -H "Content-Type: application/json" \
  --data '{"params":{"topic":"hello","depth":1}}' \
  http://127.0.0.1:8787/web/api/templates/document/run

# REST: confirms the spawned session shows up.
curl -H "Authorization: Bearer $SPELL_TOKEN_ALICE" \
  http://127.0.0.1:8787/web/api/sessions
```

A 401 on any of these means the token is missing or unmatched. A 404 on
`/web/*` means the `web` block was not parsed — re-check `server.kdl`
and the server log for warnings about dropped `env(..., optional)`
tokens whose variables were unset.

## Where to next

- [`web.md`](./web.md) — full WS protocol, REST surface, signed-URL semantics,
  frontend internals.
- [`kdl-schema-reference.md`](./kdl-schema-reference.md) — exhaustive grammar
  for `web {}`, `template { … }`, and the `event_log` bridge wire format.
- [`architecture.md`](./architecture.md) — where the Web Subsystem fits
  alongside the HTTP API, socket bridge, and execution controller.
