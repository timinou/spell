# Spell Server KDL Schema Reference

This reference documents the three KDL configuration files used by Spell Server:

- `.spell/server.kdl`
- `.spell/channels.kdl`
- `.spell/autonomy.kdl`

Examples below are written to match the shapes accepted by the current manifest parser and surrounding server types. All secrets and URLs are sanitized.

## `.spell/server.kdl`

`server.kdl` configures the HTTP listener and server-side authentication.

### `http` node

Properties and children:

- `port=<number>`: Bun listen port.
- `webhook-secret=<string>`: shared HMAC secret for webhook schedules that use `auth="hmac"`.
- child `auth` node with:
  - `username=<string>`
  - `password=<string>`

Example:

```kdl
http port=8787 webhook-secret="replace-with-a-long-random-secret" { // pragma: allowlist secret
  auth username="admin" password="change-me-now" // pragma: allowlist secret
}
```

If you use bearer-authenticated webhook goals, your server-side loader may also provide per-goal bearer tokens to the runtime `goalTokens` map represented by the HTTP config type.

## `.spell/channels.kdl`

`channels.kdl` defines external notification channels. Telegram is the primary example.

### `telegram` node

`channels.kdl` now carries the complete Telegram runtime configuration surface. The node itself takes no properties; configure it with children:

- `bot-token "<token>"` or `bot-token-file "<path>"`: required unless the whole Telegram node is omitted. These forms are mutually exclusive. `bot-token-file` is resolved relative to the config directory when loaded.
- `owners <chat-id>...`: required numeric Telegram user IDs that are allowed to receive admin notifications and owner privileges.
- `upload-dir "<path>"`: optional upload staging directory. Defaults to `"/tmp/spell-telegram-uploads"`.
- `idle-timeout <seconds>`: optional default session idle timeout. Defaults to `300`.
- `max-sessions <number>`: optional concurrent Telegram session cap. Defaults to `10`.
- `log-viewer-port <number>`: optional HTTP port for the Telegram log viewer. Omit it to disable the viewer.
- `default-model "<model>"`: required model slug passed to spawned RPC sessions.
- `project "<name>" "<path>"`: optional named project roots. Relative paths are resolved against the config directory.
- `default-project "<name>"`: optional default project name. If omitted and at least one `project` node exists, the first declared project becomes the default.
- `user <telegram-user-id> { ... }`: optional per-user overrides. Supported children are `modes "<mode>"...`, `default-mode "<mode>"`, `idle-timeout <seconds>|#null`, and `projects "<project-name>"...`. If `default-mode` is omitted it falls back to the first listed mode; if `modes` is omitted it defaults to `"telegram-readonly"`.

Example:

```kdl
telegram {
  bot-token-file "secrets/bot-token.txt"
  owners 123456789 987654321
  default-model "claude-sonnet-4-5"
  log-viewer-port 4312
  project "spell" "../spell"
  project "docs" "./docs"
  default-project "spell"
  user 123456789 {
    modes "telegram-readonly" "coding"
    default-mode "coding"
    projects "spell" "docs"
  }
  user 987654321 {
    idle-timeout #null
  }
}
```

If the `telegram` node is absent entirely, Telegram delivery is disabled. If the node is present, `default-model`, authentication (`bot-token` or `bot-token-file`), and `owners` are required. Use the KDL null literal `#null` for nullable fields such as `user { idle-timeout #null }`; bare `null` is not accepted.

## `.spell/autonomy.kdl`

`autonomy.kdl` is the core manifest read by `parseManifestKdl()`.

### Top-level nodes

#### `name`

String argument. Human-readable manifest name.

```kdl
name "project-autonomy"
```

#### `version`

String argument. Manifest version label.

```kdl
version "1.0"
```

#### `setup "<name>" { ... }`

Reusable execution policy. A goal references a setup by name.

Supported children:

- `domain "<string>"` required
- `mode "<string>"` optional
- `skills { allow ...; deny ... }` optional
- `tools { allow ...; deny ... }` optional
- `sandbox { paths-write ...; bash-allow ...; bash-deny ... }` optional
- `timeout "<duration>"` optional, for example `"30m"`, `"15s"`, `"1h"`
- `max-cost-usd <number>` optional

Example:

```kdl
setup "test-runner" {
  domain "coding"
  mode "reviewer"
  skills {
    allow "coding" "qml-testing"
  }
  tools {
    allow "read" "grep" "find" "bash" "lsp"
    deny "write"
  }
  sandbox {
    paths-write "coverage/" "test-results/"
    bash-allow "bun test*" "bun run lint*"
    bash-deny "rm -rf *"
  }
  timeout "30m"
  max-cost-usd 3.5
}
```

#### `goal "<name>" { ... }`

Concrete scheduled or webhook-triggered work.

Supported children:

- `setup "<setup-name>"` required
- `schedule ...` required
- `prompt "<text>"` required
- `hooks { ... }` optional
- `state persist=<bool> { ... }` optional
- `retry ...` optional

Example:

```kdl
goal "nightly-tests" {
  setup "test-runner"
  schedule type="cron" expression="0 2 * * *" timezone="UTC" jitter="5m"
  prompt "Run the full test suite. Report failures with file paths and actionable summaries."
  hooks {
    on-success {
      webhook "https://hooks.example.invalid/spell/success"
    }
    on-failure {
      telegram chat-id=123456789
      webhook "https://hooks.example.invalid/spell/failure" method="POST"
    }
    on-complete {
      org category="engineering"
    }
  }
  state persist=#true {
    schema "last_result" type="string"
    schema "failure_count" type="number"
    schema "details" type="json"
  }
  retry max-retries=2 initial-delay-ms=10000 multiplier=2
}
```

### Schedule types

The parser accepts two schedule kinds.

#### Cron schedule

Properties:

- `type="cron"`
- `expression="<cron expression>"` required
- `timezone="<iana zone>"` optional
- `jitter="<duration>"` optional in manifest shape

Example:

```kdl
schedule type="cron" expression="0 2 * * *" timezone="UTC" jitter="5m"
```

#### Webhook schedule

Properties:

- `type="webhook"`
- `path="<trigger-path>"` optional; if omitted, the goal name can be used as the trigger id
- `auth="hmac" | "bearer"` optional

Example:

```kdl
schedule type="webhook" path="manual-test-run" auth="hmac"
```

### Hook types

Hooks live inside a `hooks` node under one or more event groups:

- `on-success`
- `on-failure`
- `on-complete`

Each event group contains zero or more target nodes.

#### Webhook hook

- node name: `webhook`
- string argument: destination URL
- optional `method="POST" | "GET"`

```kdl
webhook "https://hooks.example.invalid/spell/events" method="POST"
```

#### Telegram hook

- node name: `telegram`
- property `chat-id=<number>`

```kdl
telegram chat-id=123456789
```

The KDL hook target still only selects the destination chat. Rich Telegram options are supplied by the runtime sender API: domains may pass a structured payload with `text`, `parseMode`, optional inline-keyboard `replyMarkup`, and `linkPreviewOptions`, while legacy text-only hook formatting keeps working unchanged.

#### Org hook

- node name: `org`
- optional property `category="<string>"`

```kdl
org category="marketing"
```

### State config

State is declared inside a goal:

- `persist=#true | #false` required
- optional repeated `schema` child nodes
- each `schema` node takes a string argument column name and `type="string" | "number" | "boolean" | "json"`

Example:

```kdl
state persist=#true {
  schema "last_sync_date" type="string"
  schema "total_pipeline_value" type="number"
  schema "is_healthy" type="boolean"
  schema "raw_payload" type="json"
}
```

## Full Config Examples

### Full `server.kdl`

```kdl
http port=8787 webhook-secret="replace-with-a-long-random-secret" { // pragma: allowlist secret
  auth username="admin" password="change-me-now" // pragma: allowlist secret
}
```

### Full `channels.kdl`

```kdl
telegram {
  bot-token-file "secrets/bot-token.txt"
  owners 123456789 987654321
  upload-dir "/tmp/spell-telegram-uploads"
  idle-timeout 300
  max-sessions 10
  log-viewer-port 4312
  default-model "claude-sonnet-4-5"
  project "spell" "../spell"
  project "docs" "./docs"
  default-project "spell"
  user 123456789 {
    modes "telegram-readonly" "coding"
    default-mode "coding"
    projects "spell" "docs"
  }
  user 987654321 {
    idle-timeout #null
  }
}
```

### Full `autonomy.kdl`

```kdl
name "example-autonomy"
version "1.0"

setup "test-runner" {
  domain "coding"
  mode "reviewer"
  tools {
    allow "read" "grep" "find" "bash" "lsp"
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
  prompt "Run the full test suite. Report failures with file paths and actionable summaries."
  hooks {
    on-success {
      webhook "https://hooks.example.invalid/spell/success"
    }
    on-failure {
      telegram chat-id=123456789
      webhook "https://hooks.example.invalid/spell/failure"
    }
    on-complete {
      org category="engineering"
    }
  }
  state persist=#true {
    schema "last_result" type="string"
    schema "failure_count" type="number"
  }
  retry max-retries=2 initial-delay-ms=10000 multiplier=2
}
```

## Domain Examples

### Coding domain

```kdl
name "coding-automation"
version "1.0"

setup "test-runner" {
  domain "coding"
  mode "reviewer"
  tools {
    allow "read" "grep" "find" "bash" "lsp"
  }
  sandbox {
    paths-write "test/" "coverage/"
    bash-allow "bun test*" "bun run lint*"
  }
  timeout "30m"
}

goal "nightly-tests" {
  setup "test-runner"
  schedule type="cron" expression="0 2 * * *" timezone="UTC"
  prompt "Run the full test suite. Report failures with file paths and error messages."
  hooks {
    on-success {
      webhook "https://hooks.example.invalid/slack/success"
    }
    on-failure {
      telegram chat-id=12345
      webhook "https://hooks.example.invalid/pagerduty/failure"
    }
  }
}

goal "security-review" {
  setup "test-runner"
  schedule type="cron" expression="0 3 * * 1" timezone="UTC"
  prompt "Review the changed code for security-sensitive issues and summarize only high-confidence findings."
}

goal "lint-checker" {
  setup "test-runner"
  schedule type="webhook" path="lint-checker" auth="bearer"
  prompt "Run lint checks and report the first failing files with the exact command output."
}
```

### Sales domain

```kdl
name "sales-automation"
version "1.0"

setup "sales-analyst" {
  domain "sales"
  tools {
    allow "read" "grep" "find" "web_search" "fetch"
  }
  timeout "15m"
}

goal "weekly-pipeline-report" {
  setup "sales-analyst"
  schedule type="cron" expression="0 8 * * 1" timezone="America/New_York"
  prompt "Generate a weekly sales pipeline report with stage breakdown, top opportunities, and notable changes from last week."
  state persist=#true {
    schema "last_sync_date" type="string"
    schema "total_pipeline_value" type="number"
  }
  hooks {
    on-complete {
      telegram chat-id=67890
    }
  }
}

goal "lead-scoring" {
  setup "sales-analyst"
  schedule type="cron" expression="0 9 * * *" timezone="America/New_York"
  prompt "Review new inbound leads, score them by fit and urgency, and produce a prioritized follow-up list."
}

goal "crm-sync-review" {
  setup "sales-analyst"
  schedule type="webhook" path="crm-sync-review" auth="hmac"
  prompt "Validate the latest CRM import, identify duplicate or malformed records, and summarize the issues."
}
```

### Marketing domain

```kdl
name "marketing-automation"
version "1.0"

setup "content-reviewer" {
  domain "marketing"
  tools {
    allow "read" "grep" "find" "web_search" "fetch"
  }
  timeout "20m"
}

goal "daily-seo-audit" {
  setup "content-reviewer"
  schedule type="cron" expression="0 6 * * *" timezone="Europe/London"
  prompt "Audit our website pages for SEO issues, including missing titles, weak meta descriptions, and broken internal links."
  hooks {
    on-failure {
      webhook "https://hooks.example.invalid/slack/seo-failure"
    }
    on-complete {
      org category="marketing"
    }
  }
}

goal "content-review" {
  setup "content-reviewer"
  schedule type="cron" expression="0 10 * * 1-5" timezone="Europe/London"
  prompt "Review draft content for clarity, brand consistency, and risky claims that need human approval."
}

goal "social-scheduler" {
  setup "content-reviewer"
  schedule type="webhook" path="social-scheduler" auth="bearer"
  prompt "Prepare a short social posting schedule from the supplied campaign context and note any missing assets."
}
```
