# Spell Web Dashboard

The web dashboard ships inside `@oh-my-pi/spell-server`. It surfaces a single
HTTP/WS endpoint at `/web/*` so a small group of authenticated humans can
drive `spell-server` and its sessions from a browser.

## What it does

- **Auto-discovery.** The unified `SocketSessionRegistry` exposes both
  server-spawned RPC sessions and external CLI sessions registered via the
  Unix-socket bridge. The frontend renders both kinds in one list.
- **Spawn from templates.** The `template "<name>" { … }` autonomy.kdl node
  declares a parameterized preset. Pick one via `Cmd/Ctrl+K`, fill the
  inputs, hit run; the server spawns an RPC session, fires the rendered
  prompt as the first command, and registers the session under
  `ownedBy: <token-name>`.
- **Live stream + bash.** xterm.js renders the RPC event stream as ANSI text
  with a prompt textarea (`Cmd+Enter` to submit). A Bash tab will surface
  per-command output once the RPC server gains a top-level `bash` command;
  external sessions hide that tab.
- **Artifact serving.** `/web/artifacts/<session>/<agent>/<tool>/<file>` is
  served with bearer auth or a short-lived HMAC-signed URL. Newly written
  artifacts trigger an `artifact_created` WebSocket event; the frontend can
  filter by file extension (the template's `artifact-watch` ext list is
  the default).

## Auth model

Configure named bearer tokens in `server.kdl`:

```kdl
web {
    token "alice" "env(SPELL_TOKEN_ALICE)"
    token "bob"   "env(SPELL_TOKEN_BOB, optional)"
}
```

- Tokens may be literal strings or `env(VAR)` references resolved at startup.
- An `env(VAR, optional)` reference whose variable is unset is **silently
  dropped** so an admin can pre-declare slots that are off by default.
- Tokens are presented either as `Authorization: Bearer <secret>` (REST and
  XHR) or `?token=<secret>` (WebSocket upgrade — browsers cannot set custom
  headers on `new WebSocket()`).
- Identity = `{ name }` of the matching token. The server attaches it to the
  spawned session as `ownedBy`.

## Session model (hybrid)

| Origin | Shape | Steerable? |
|---|---|---|
| `kind: "spawned"` | `WebSessionHub` owns an `RpcClient`. | Full RPC: `prompt`, `abort`, `get_state`, `get_session_stats`. |
| `kind: "external"` | A CLI `spell` session connects via the Unix socket bridge. | Read-only: receive `event_log` summaries, answer pending blocking events. |

Spawned sessions show in the sidebar before external ones, both ordered by
`startedAt` ascending.

## Templates

```kdl
template "document" {
    description "Generate a typst PDF report"
    setup "writer"
    mode "rpc"            // only "rpc" in v1
    prompt "Generate a typst PDF report on {{topic}}."
    param "topic" type="string" required=#true
    param "depth" type="number"
    artifact-watch ".pdf" ".png"
}
```

- `setup` references a manifest setup, including alias-imported setups
  (`<alias>.<name>`).
- `prompt` is rendered via Handlebars at run time; missing variables become
  the empty string with a warning logged once.
- `param` values are coerced from JSON inputs (number/string/boolean).
- `artifact-watch.ext` propagates as `watchExtensions` on the spawned
  session and feeds the frontend's "ready" badge logic.

## WebSocket protocol summary

Endpoint: `wss?://<host>/web/ws?token=<secret>`. After upgrade, server sends
`{ type: "auth_ok", identity: { name } }`. Clients then issue `list_sessions`
to seed state and `subscribe { sessionId, channels }` to opt in to per-session
streams. Channels: `events`, `artifacts`, `state`. See
`packages/spell-server/src/web/ws/protocol.ts` for the typed unions.

Server-pushed messages include:
- `session_added | session_updated | session_removed`
- `rpc_event` (excluding bare `response`s)
- `rpc_response` (correlated with `correlationId`)
- `external_event_log` for bridge-relayed CLI summaries
- `artifact_created` (subject to the connection's per-session ext filter)

## Artifact HTTP

- `GET /web/artifacts/<sessionId>/<agent>/<tool>/<file>` — bearer-auth file
  download. Use `?download=1` for `Content-Disposition: attachment`.
- `POST /web/api/sessions/<id>/artifacts/url` — mint a short-lived
  HMAC-SHA256-signed URL (`?sig=&exp=`) for embed contexts (`<iframe src>`,
  `<img src>`). The HMAC key is derived from `http.webhookSecret` if
  configured, else from a SHA-256 of the sorted token map.
- `GET /web/api/sessions/<id>/artifacts` — list artifacts under the spawned
  session's root.

## Frontend (Vite SPA)

The SPA lives at `packages/spell-server/web/`. It builds into a `dist/`
directory the server eagerly loads at startup. Highlights:

- React 19 + zustand + cmdk for state and command-palette UX.
- xterm.js (with `addon-fit` and `addon-web-links`) for both Stream and Bash
  tabs. `StreamRenderer.ts` is a pure helper translating RPC events into
  ANSI bytes — it is unit-tested without a real terminal.
- `SpellWsClient` queues sends until the server delivers `auth_ok`, with a
  capped reconnect backoff (1, 2, 4, 8, 16, 30 s).
- All theme tokens mirror the legacy `/` admin dashboard so both feel native.

### Build

```sh
bun run --cwd=packages/spell-server build:web
```

This installs `web/` dependencies (frozen-lockfile when possible) and runs
`vite build`. The bundle is referenced at runtime by the server's
`loadWebAssets()` helper, which surfaces a clear "frontend bundle missing"
placeholder when `dist/` is absent.

### Dev mode

`bun run --cwd=packages/spell-server/web dev` proxies `/web/api`,
`/web/artifacts`, and `/web/ws` to a running spell-server on port 8787.

## Operations

- The web subsystem activates if and only if `server.web` is declared.
  Without it, `/web/*` returns 404.
- Sessions started outside the daemon participate fully when the CLI side
  emits the `event_log` bridge messages (opt-in via `SPELL_BRIDGE_EVENT_LOG=1`
  or the constructor flag on `SessionBridgeClient`).
- Two browser tabs against one server share state automatically through
  registry fan-out.
