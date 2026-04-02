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
- `.spell/channels.kdl` optionally defines delivery channels such as Telegram.

### 1. Create `.spell/server.kdl`

This file controls the dashboard port, basic auth for `/api/*`, and shared trigger authentication.

```kdl
http port=8787 webhook-secret="replace-with-long-random-secret" { // pragma: allowlist secret
  auth username="admin" password="change-me-now" // pragma: allowlist secret
}
```

Use a real random password and webhook secret in production. Basic auth protects the dashboard API. The webhook secret is used when a goal requests HMAC verification for a webhook schedule.

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

If you want Telegram notifications, declare the bot token and owner chat IDs:

```kdl
telegram bot-token="123456:replace-me" {
  owners 123456789 987654321
}
```

The hooks layer can then send completion or failure messages to configured chats.

For richer delivery, downstream code may call the notification sender with a structured payload instead of plain text. The reusable sender now accepts `{ text, parseMode, replyMarkup, linkPreviewOptions }`, so a domain can ship HTML/Markdown digests, inline approval buttons, and explicit preview controls while still using the same Telegram channel configuration.

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

You can also inspect the raw manifest the server loaded:

```bash
curl -u admin:change-me-now http://127.0.0.1:8787/api/manifest
```

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

Example goal:

```kdl
goal "manual-test-run" {
  setup "test-runner"
  schedule type="webhook" path="manual-test-run" auth="hmac"
  prompt "Run the test suite now and report the result."
}
```

Trigger it with curl:

```bash
BODY='{"reason":"manual validation"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'replace-with-long-random-secret' -binary | xxd -p -c 256)
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Signature-256: sha256=$SIG" \
  --data "$BODY" \
  http://127.0.0.1:8787/trigger/manual-test-run
```

If the request is accepted, the server returns HTTP 202 and starts the goal in the background.

## Optional Telegram Notifications

When Telegram is configured, add a Telegram hook target to your goal:

```kdl
hooks {
  on-failure {
    telegram chat-id=123456789
  }
}
```

Failure hooks are usually the best first use. A short message includes the goal name, status, duration, error, and summary when present.

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
