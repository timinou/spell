# Spell Server Getting Started

Spell Server runs scheduled or webhook-triggered autonomous goals from a project-local `.spell/` directory. It combines KDL configuration parsing, long-lived agent sessions via the internal RPC module, an optional Telegram bot for interactive chat, and a lightweight Bun HTTP server with a browser dashboard. The result is a foreground daemon you can supervise with systemd, launch locally during development, or embed in a larger automation environment.

This guide walks through the smallest useful setup: install the package, create the three configuration files, start the server, verify the HTTP API, and define a first nightly goal.

## Prerequisites

You need:

- Bun 1.3.7 or newer. The package declares Bun in `engines` and uses Bun APIs directly.
- A project directory that contains a `.spell/` directory. Spell Server expects configuration to live under that tree.
- A working Spell environment for the goals you intend to run. In practice that means the agent runtime, allowed tools, and any credentials your goals need are already available on the machine.

Create the directory if it does not exist yet:

```bash
mkdir -p .spell
```

## Installation

You can run Spell Server from the monorepo during development or add the package directly to another Bun project.

Install it as a dependency:

```bash
bun add @oh-my-pi/spell-server
```

The package exposes a `spell-server` binary in `package.json`, and the package start script runs `bun run src/main.ts`. During local monorepo development, the common pattern is to run the entrypoint directly with Bun:

```bash
bun run packages/spell-server/src/main.ts
```

If your Spell CLI exposes the integrated command, the equivalent form is:

```bash
spell server start
```

Spell Server is designed as a foreground process. Do not daemonize it internally. Let systemd, runit, Docker, Kubernetes, or your process manager restart it.

## Configuration Files

Spell Server uses up to three KDL files in `.spell/`:

- `.spell/server.kdl` defines the HTTP listener and authentication.
- `.spell/autonomy.kdl` defines setups and goals.
- `.spell/channels.kdl` optionally enables Telegram as an interactive channel or notification sink.

## Usage Paths

Two primary usage patterns exist. They are not mutually exclusive.

**Autonomous goals** — Goals defined in `autonomy.kdl` run on cron schedules or in response to inbound webhooks. The server executes them unattended and can emit notifications to Telegram on completion or failure.

**Interactive Telegram sessions** — With `channels.kdl` configured, users listed under `owners` or explicit `user` blocks can open a conversation with the bot and interact with Spell directly: run goals on demand, respond to approval prompts, and receive blocking-event notifications mid-run. See [Telegram Bridge Guide](telegram-bridge.md) for full setup.

### 1. Create `.spell/server.kdl`

This file controls the dashboard port, basic auth for `/api/*`, and shared trigger authentication.

```kdl
http {
  port 8787
  webhook-secret "replace-with-long-random-secret" // pragma: allowlist secret
  auth {
    username "admin"
    password "change-me-now" // pragma: allowlist secret
  }
}
```

Use a real random password and webhook secret in production. Basic auth protects the dashboard API. The webhook secret is used when a goal requests HMAC verification for a webhook schedule.

To enable per-goal bearer token authentication for webhook triggers, add `goal-token` entries:

```kdl
http {
  port 8787
  auth {
    username "admin"
    password "change-me-now" // pragma: allowlist secret
  }
  goal-token "nightly-tests" "secret-token-for-nightly" // pragma: allowlist secret
}
```

Each `goal-token` takes two arguments: the goal name and the token. The trigger endpoint will then require `Authorization: Bearer <token>` for that goal.

#### Socket bridge

To enable forwarding of blocking agent events (approvals, ask prompts) to Telegram during a goal run, add a `socket` node:

```kdl
http {
  port 8787
  auth {
    username "admin"
    password "change-me-now" // pragma: allowlist secret
  }
}

socket path="~/.spell/server.sock"
```

When `socket` is present, the server opens a Unix domain socket at the specified path. The Telegram bridge connects to this socket to receive real-time blocking events from running goals and forward them to the relevant Telegram session. Without this node, the socket is not created and interactive blocking-event forwarding is disabled.

### 2. Create `.spell/autonomy.kdl`

This is the main manifest. It declares reusable setups and concrete goals.

```kdl
name "example-autonomy"
version "1.0"

setup "test-runner" {
  domain "coding"
  mode "reviewer"
  tools {
    allow "read" "grep" "find" "bash"
  }
  sandbox {
    paths-write "coverage/" "test-results/"
    bash-allow "bun test*" "bun run lint*"
  }
  timeout "30m"
}

goal "nightly-tests" {
  setup "test-runner"
  schedule type="cron" expression="0 2 * * *" timezone="UTC"
  prompt "Run the full test suite. Summarize failures with file paths and the first actionable error."
  hooks {
    on-success {
      webhook "https://hooks.example.invalid/spell/success"
    }
    on-failure {
      webhook "https://hooks.example.invalid/spell/failure"
    }
  }
}
```

### 3. Optionally create `.spell/channels.kdl`

`channels.kdl` configures Telegram as a delivery channel. It supports both passive notification hooks and fully interactive sessions. A complete example with project routing and per-user overrides:

```kdl
telegram {
  bot-token-file ".spell/bot-token"
  owners 123456789 987654321
  default-model "claude-sonnet-4-5"
  upload-dir "/var/spell/uploads"
  idle-timeout 300
  max-sessions 10

  project "api" "/srv/projects/api"
  project "infra" "/srv/projects/infra"
  default-project "api"

  user 123456789 {
    modes "telegram-readonly" "telegram-code"
    default-mode "telegram-readonly"
    idle-timeout #null
  }

  user 987654321 {
    modes "telegram-readonly"
    default-mode "telegram-readonly"
    idle-timeout 600
  }
}
```

Key fields:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `bot-token` | one of | — | Bot token inline (mutually exclusive with `bot-token-file`) |
| `bot-token-file` | one of | — | Path to file containing the token; resolved relative to config dir |
| `owners` | yes | — | Space-separated numeric Telegram chat IDs with full access |
| `default-model` | yes | — | Model identifier for Telegram-initiated agent sessions |
| `upload-dir` | no | `/tmp/spell-telegram-uploads` | Local directory for user-uploaded files |
| `idle-timeout` | no | `300` | Seconds of inactivity before a session is closed; `#null` disables |
| `max-sessions` | no | `10` | Maximum concurrent Telegram sessions |
| `project` | no | — | Registers a named project: `project "name" "/path"` |
| `default-project` | no | first project | Project selected when a session starts without an explicit project |
| `user` | no | — | Per-user overrides; argument is the numeric Telegram user ID |

Inside a `user` block:

| Field | Description |
|-------|-------------|
| `modes` | List of agent modes available to this user |
| `default-mode` | Mode used when the session starts |
| `idle-timeout` | Per-user idle timeout; `#null` disables; overrides global setting |

`bot-token` and `bot-token-file` are mutually exclusive. The `owners` list grants unrestricted access; `user` blocks can restrict available modes for specific users.

For full details on interactive sessions, mode configuration, and approval handling, see [Telegram Bridge Guide](telegram-bridge.md).

## Running the Server

From the monorepo:

```bash
bun run packages/spell-server/src/main.ts
```

From the package itself:

```bash
bun run src/main.ts
```

If your CLI wrapper is installed:

```bash
spell server start
```

Keep the process in the foreground. You should see the HTTP listener bind to the configured port, after which the dashboard and trigger endpoints are live.

## Verifying the Server

First, confirm the goal list API answers over basic auth:

```bash
curl -u admin:change-me-now http://127.0.0.1:8787/api/goals
```

Then open the dashboard in a browser:

```text
http://127.0.0.1:8787/
```

The dashboard is a small Preact/HTM frontend served directly by the Bun HTTP server. It polls the API every 10 seconds, shows manifest metadata, lists goals, and lets you trigger a run manually.

### API route reference

All `/api/*` routes require HTTP Basic Auth.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/goals` | List all goals with status |
| `GET` | `/api/goals/:name` | Single goal detail |
| `GET` | `/api/goals/:name/runs` | Run history for a goal |
| `GET` | `/api/goals/:name/logs` | Logs for the latest run |
| `GET` | `/api/manifest` | Full parsed manifest |
| `GET` | `/api/state` | List state stores |
| `GET` | `/api/state/:store/tables` | List tables in a store |
| `GET` | `/api/state/:store/tables/:table` | Query a table |
| `GET` | `/api/state/:store/tables/:table/count` | Row count for a table |
| `GET POST` | `/api/approvals` | List or create approval items |
| `GET` | `/api/approvals/:id` | Single approval item |
| `POST` | `/api/approvals/:id/claim` | Claim an approval item |
| `DELETE` | `/api/approvals/:id/claim` | Release a claim |
| `POST` | `/api/approvals/:id/actions` | Apply an action to an approval |
| `GET POST` | `/api/downstream-jobs` | List or inspect downstream jobs |
| `GET` | `/api/downstream-jobs/:id` | Single downstream job |
| `POST` | `/api/operator-actions` | Dispatch an operator action |
| `POST` | `/trigger/:id` | Trigger a webhook-scheduled goal |

The `/api/state/*`, `/api/approvals/*`, and `/api/downstream-jobs/*` routes require the workflow engine to be configured; they return HTTP 501 otherwise.

## Your First Goal: Nightly Test Runner

A good first goal is a nightly test runner because it is easy to verify and does not require inbound webhooks.

1. Create the `test-runner` setup shown above.
2. Add the `nightly-tests` goal with a cron schedule.
3. Start the server.
4. Wait for the next scheduled time or trigger it manually from the dashboard.
5. Review `/api/goals/nightly-tests` and `/api/goals/nightly-tests/runs`.

The execution controller tracks each run attempt, its start and completion time, status, and any error. If the goal fails, retries are attempted before the goal moves through escalation and eventually pauses.

## Manual Webhook Trigger

Webhook schedules are useful for ad hoc runs, CI callbacks, or external systems that know when work is ready.

### HMAC authentication

```kdl
goal "manual-test-run" {
  setup "test-runner"
  schedule type="webhook" path="manual-test-run" auth="hmac"
  prompt "Run the test suite now and report the result."
}
```

Trigger with HMAC signature:

```bash
BODY='{"reason":"manual validation"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'replace-with-long-random-secret' -binary | xxd -p -c 256)
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Signature-256: sha256=$SIG" \
  --data "$BODY" \
  http://127.0.0.1:8787/trigger/manual-test-run
```

### Bearer token authentication

For goals that need simpler token-based auth instead of HMAC, use `auth="bearer"` in the schedule and declare a matching `goal-token` in `server.kdl`:

```kdl
// server.kdl
http {
  port 8787
  auth {
    username "admin"
    password "change-me-now" // pragma: allowlist secret
  }
  goal-token "ci-run" "my-ci-secret-token" // pragma: allowlist secret
}
```

```kdl
// autonomy.kdl
goal "ci-run" {
  setup "test-runner"
  schedule type="webhook" path="ci-run" auth="bearer"
  prompt "Run the test suite now and report the result."
}
```

Trigger with bearer token:

```bash
curl -X POST \
  -H "Authorization: Bearer my-ci-secret-token" \
  -H "Content-Type: application/json" \
  --data '{}' \
  http://127.0.0.1:8787/trigger/ci-run
```

### Overlap protection

If a goal is already running when the trigger endpoint is called, the server returns HTTP 409. The response body is:

```json
{"error":"Goal already running"}
```

The caller should back off and retry after the running instance completes, or check `/api/goals/:name` to monitor the in-progress run.

If the request is accepted, the server returns HTTP 202 and starts the goal in the background.

## Telegram Integration

When Telegram is configured via `channels.kdl`, it serves two roles.

**Notifications** — Add a Telegram hook target to any goal to receive a message on success or failure:

```kdl
hooks {
  on-failure {
    telegram chat-id=123456789
  }
}
```

Failure hooks are usually the best first use. A short message includes the goal name, status, duration, error, and summary when present.

**Interactive sessions** — Owners and authorized users can open a direct conversation with the bot to run goals on demand, switch projects, and respond to blocking events (approvals, prompts) without accessing the dashboard. The socket bridge in `server.kdl` enables real-time event forwarding from running goals to the Telegram session.

For full configuration — mode definitions, per-user access control, approval workflows, and voice support — see [Telegram Bridge Guide](telegram-bridge.md).

## systemd Example

For production, let systemd supervise the foreground process:

```ini
[Unit]
Description=Spell Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/srv/my-project
ExecStart=/usr/bin/bun run /srv/my-project/packages/spell-server/src/main.ts
Restart=on-failure
RestartSec=5
Environment=HOME=/srv/spell
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Replace `ExecStart` with your installed `spell server start` command if you ship the CLI wrapper. Keep secrets out of the unit file when possible; use `EnvironmentFile=` or a secret manager instead.

Once the unit is enabled and started, revisit the curl checks above to confirm the listener, auth, and dashboard are working end to end.
